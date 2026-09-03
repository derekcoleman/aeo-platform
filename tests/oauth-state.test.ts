import { describe, expect, it } from "vitest";
import { OAUTH_STATE_TTL_MS, createOAuthState, verifyOAuthState } from "@/lib/connectors/oauth-state";
import { authorizeUrlFor } from "@/lib/connectors/oauth-start";

const SECRET = "a-sufficiently-long-state-secret";
const NOW = new Date("2026-09-01T12:00:00Z");
const input = { orgId: "11111111-1111-1111-1111-111111111111", siteId: null, provider: "google" as const, userId: "u1", returnTo: "/settings/connectors" };

describe("oauth state", () => {
  it("round-trips a signed state", () => {
    const state = createOAuthState(SECRET, input, NOW);
    const back = verifyOAuthState(SECRET, state, new Date(NOW.getTime() + 60_000));
    expect(back).toMatchObject(input);
    expect(back?.exp).toBe(NOW.getTime() + OAUTH_STATE_TTL_MS);
  });

  it("rejects tampering, the wrong secret, and expiry", () => {
    const state = createOAuthState(SECRET, input, NOW);
    const [payload, sig] = state.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), orgId: "22222222-2222-2222-2222-222222222222" })).toString("base64url");
    expect(verifyOAuthState(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
    expect(verifyOAuthState("another-secret-of-adequate-len", state, NOW)).toBeNull();
    expect(verifyOAuthState(SECRET, state, new Date(NOW.getTime() + OAUTH_STATE_TTL_MS + 1))).toBeNull();
    expect(verifyOAuthState(SECRET, "garbage", NOW)).toBeNull();
    expect(verifyOAuthState("", state, NOW)).toBeNull();
  });

  it("refuses a weak secret and a non-root-relative returnTo", () => {
    expect(() => createOAuthState("short", input, NOW)).toThrow(/16 characters/);
    const state = createOAuthState(SECRET, { ...input, returnTo: "//evil.example" as string }, NOW);
    expect(verifyOAuthState(SECRET, state, NOW)).toBeNull();
  });
});

describe("authorizeUrlFor", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    OAUTH_STATE_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "gid",
    GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://app.example.com/api/connectors/google/callback",
    SLACK_CLIENT_ID: "sid",
    SLACK_CLIENT_SECRET: "ssecret",
    SLACK_REDIRECT_URI: "https://app.example.com/api/connectors/slack/callback",
  };

  it("builds provider authorize URLs carrying a verifiable state and no secrets", () => {
    for (const provider of ["google", "slack"] as const) {
      const url = new URL(authorizeUrlFor(provider, { orgId: input.orgId, siteId: null, userId: "u1", returnTo: "/x" }, env, NOW));
      const state = verifyOAuthState(SECRET, url.searchParams.get("state"), NOW);
      expect(state).toMatchObject({ provider, orgId: input.orgId, userId: "u1", returnTo: "/x" });
      expect(url.href).not.toMatch(/secret/i);
      expect(url.searchParams.get("redirect_uri")).toContain(`/api/connectors/${provider}/callback`);
    }
  });

  it("fails loudly when the provider is not configured", () => {
    expect(() => authorizeUrlFor("slack", { orgId: input.orgId, siteId: null }, { NODE_ENV: "test", OAUTH_STATE_SECRET: SECRET }, NOW)).toThrow(/SLACK_CLIENT_ID/);
  });
});
