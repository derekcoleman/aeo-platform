import { describe, expect, it } from "vitest";
import { authHookCheck, envChecks, inngestSignature, jobsEndpointCheck, jwtClaims } from "@/lib/ops/setup";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("envChecks", () => {
  it("accepts either our names or the Vercel integration's", () => {
    const ours = envChecks(env({ NEXT_PUBLIC_SUPABASE_URL: "x", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k", DATABASE_URL: "d" }));
    expect(ours.find((c) => c.key === "env.supabase_url")?.state).toBe("ok");
    expect(ours.find((c) => c.key === "env.database_url")?.state).toBe("ok");
    const theirs = envChecks(env({ SUPABASE_URL: "x", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k", POSTGRES_URL: "d" }));
    expect(theirs.find((c) => c.key === "env.supabase_url")?.state).toBe("ok");
    expect(theirs.find((c) => c.key === "env.publishable_key")?.detail).toContain("ANON_KEY");
  });
  it("marks required variables as failures and optional ones as warnings", () => {
    const checks = envChecks(env({}));
    expect(checks.find((c) => c.key === "env.service_role")?.state).toBe("fail");
    expect(checks.find((c) => c.key === "env.slack")?.state).toBe("warn");
    expect(checks.every((c) => c.state === "ok" || c.fix)).toBe(true);
  });
});

describe("jwtClaims + authHookCheck", () => {
  const token = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  const configured = env({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" });
  it("passes when the hook's claims are present", () => {
    expect(authHookCheck(jwtClaims(token({ sub: "u", org_ids: ["o"], is_staff: false })), configured).state).toBe("ok");
  });
  it("fails with the dashboard fix when they are missing", () => {
    const c = authHookCheck(jwtClaims(token({ sub: "u" })), configured);
    expect(c.state).toBe("fail");
    expect(c.fix).toContain("custom_access_token_hook");
  });
  it("skips when auth is not configured and warns without a token", () => {
    expect(authHookCheck(null, env({})).state).toBe("skip");
    expect(authHookCheck(null, configured).state).toBe("warn");
    expect(jwtClaims("garbage")).toBeNull();
  });
});

describe("jobsEndpointCheck", () => {
  const env = { APP_URL: "https://app.example.test/" } as unknown as NodeJS.ProcessEnv;
  const respond = (status: number, body: string | null, headers: Record<string, string> = {}) => (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

  it("passes when the Inngest handler answers its introspection JSON with keys present", async () => {
    const c = await jobsEndpointCheck(env, respond(200, JSON.stringify({ function_count: 27, mode: "cloud", has_event_key: true, has_signing_key: true })));
    expect(c).toMatchObject({ state: "ok", detail: "27 functions registered, mode cloud" });
  });

  it("fails with the Deployment Protection fix when the endpoint redirects to Vercel SSO", async () => {
    const c = await jobsEndpointCheck(env, respond(302, null, { location: "https://vercel.com/sso-api?url=https%3A%2F%2Fapp.example.test%2Fapi%2Finngest" }));
    expect(c.state).toBe("fail");
    expect(c.detail).toContain("redirects to Vercel SSO");
    expect(c.fix).toContain("Only Preview Deployments");
  });

  it("fails when the running build predates the keys", async () => {
    const c = await jobsEndpointCheck(env, respond(200, JSON.stringify({ function_count: 27, mode: "dev", has_event_key: false, has_signing_key: false })));
    expect(c.state).toBe("fail");
    expect(c.fix).toContain("Redeploy");
  });

  it("signs the request with the deployment's key, ignoring the signkey prefix", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ function_count: 3, mode: "cloud", has_event_key: true, has_signing_key: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = await jobsEndpointCheck({ APP_URL: "https://app.example.test", INNGEST_SIGNING_KEY: "signkey-prod-abc123" } as unknown as NodeJS.ProcessEnv, fetchImpl);
    expect(c.state).toBe("ok");
    expect(seen[0]?.["x-inngest-signature"]).toMatch(/^t=\d+&s=[0-9a-f]{64}$/);
    const at = 1_789_479_538_000;
    expect(inngestSignature("signkey-prod-abc123", undefined, at)).toBe(inngestSignature("abc123", undefined, at));
    expect(inngestSignature("abc123", undefined, at)).not.toBe(inngestSignature("abc123", "", at));
  });

  it("tells the SDK's own 401 apart from Deployment Protection", async () => {
    const sdk401 = respond(401, JSON.stringify({ message: "Unauthorized" }), { "x-inngest-sdk-handled": "true" });
    const noKey = await jobsEndpointCheck(env, sdk401);
    expect(noKey.state).toBe("fail");
    expect(noKey.detail).toContain("INNGEST_SIGNING_KEY is not set");
    const wrongKey = await jobsEndpointCheck({ APP_URL: "https://app.example.test", INNGEST_SIGNING_KEY: "signkey-prod-x" } as unknown as NodeJS.ProcessEnv, sdk401);
    expect(wrongKey.state).toBe("warn");
    expect(wrongKey.fix).toContain("Signing key");
    const gate = await jobsEndpointCheck(env, respond(401, "denied"));
    expect(gate.state).toBe("fail");
    expect(gate.fix).toContain("Only Preview Deployments");
  });

  it("skips without APP_URL and fails on a network error", async () => {
    expect((await jobsEndpointCheck({} as unknown as NodeJS.ProcessEnv, respond(200, "{}"))).state).toBe("skip");
    const c = await jobsEndpointCheck(env, (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch);
    expect(c.state).toBe("fail");
    expect(c.detail).toContain("ENOTFOUND");
  });
});
