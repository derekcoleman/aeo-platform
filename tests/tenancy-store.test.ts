import { describe, expect, it } from "vitest";
import { HttpSiteStore } from "@/lib/tenancy/store";
import { SiteLookupError } from "@/lib/tenancy/resolve-site";

const row = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  org_id: "11111111-1111-1111-1111-111111111111",
  canonical_domain: "acme.com",
  path_prefix: "/resources",
  edge_hostname: "acme-8fj2.blogedge.aeo.app",
  proxy_mode: "cloudflare_worker",
  trailing_slash: "never",
  locale: "en-US",
  status: "active",
  site_domains: [{ hostname: "acme.com" }, { hostname: "www.acme.com" }],
};

function fetchWith(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("HttpSiteStore", () => {
  it("reads app.sites through PostgREST with the service key and the app schema profile", async () => {
    const f = fetchWith(200, [row]);
    const store = new HttpSiteStore("https://chutvdrkvdfdynyactmm.supabase.co", "service-key", f.fetchImpl);
    const site = await store.byEdgeHostname("ACME-8fj2.blogedge.aeo.app");
    expect(site?.id).toBe(row.id);
    expect(site?.allowedHosts).toEqual(["acme.com", "www.acme.com"]);
    const call = f.calls[0]!;
    expect(call.url.startsWith("https://chutvdrkvdfdynyactmm.supabase.co/rest/v1/sites?")).toBe(true);
    expect(call.url).toContain("edge_hostname=eq.acme-8fj2.blogedge.aeo.app");
    expect(call.headers.apikey).toBe("service-key");
    expect(call.headers.authorization).toBe("Bearer service-key");
    expect(call.headers["accept-profile"]).toBe("app");
  });

  it("an unconfigured base URL is a lookup error (503 upstream), never a thrown TypeError", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("[]"); }) as unknown as typeof fetch;
    await expect(new HttpSiteStore("", "k", fetchImpl).byEdgeHostname("acme-8fj2.blogedge.aeo.app")).rejects.toBeInstanceOf(SiteLookupError);
    expect(called).toBe(false);
  });

  it("an empty result is a miss; a non-OK response is a lookup error, never a miss", async () => {
    expect(await new HttpSiteStore("https://x.supabase.co", "k", fetchWith(200, []).fetchImpl).byEdgeHostname("nope.blogedge.aeo.app")).toBeNull();
    await expect(new HttpSiteStore("https://x.supabase.co", "k", fetchWith(404, { message: "schema not exposed" }).fetchImpl).byEdgeHostname("acme-8fj2.blogedge.aeo.app")).rejects.toBeInstanceOf(SiteLookupError);
  });
});
