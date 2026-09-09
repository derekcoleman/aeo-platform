import { describe, expect, it } from "vitest";
import { canonicalHostRedirect, hasAuthParams, safeNext, strayAuthRedirect } from "@/lib/auth/callback";

describe("safeNext", () => {
  it("accepts same-origin paths only", () => {
    expect(safeNext("/app/sites/1")).toBe("/app/sites/1");
    expect(safeNext("https://evil.example/x")).toBe("/app");
    expect(safeNext("//evil.example")).toBe("/app");
    expect(safeNext("/\\evil.example")).toBe("/app");
    expect(safeNext(null)).toBe("/app");
    expect(safeNext("", "/ops")).toBe("/ops");
  });
});

describe("strayAuthRedirect", () => {
  const u = (s: string) => new URL(s, "https://app.example.com");

  it("forwards a PKCE code that landed on the home page", () => {
    const r = strayAuthRedirect(u("/?code=abc"));
    expect(r?.pathname).toBe("/auth/callback");
    expect(r?.searchParams.get("code")).toBe("abc");
    expect(r?.searchParams.get("next")).toBeNull();
  });

  it("keeps the landing path as the destination when it is not the root", () => {
    const r = strayAuthRedirect(u("/app/sites/1?code=abc"));
    expect(r?.searchParams.get("next")).toBe("/app/sites/1");
  });

  it("carries token_hash + type links too", () => {
    const r = strayAuthRedirect(u("/?token_hash=h&type=magiclink&next=/ops"));
    expect(r?.searchParams.get("token_hash")).toBe("h");
    expect(r?.searchParams.get("type")).toBe("magiclink");
    expect(r?.searchParams.get("next")).toBe("/ops");
  });

  it("leaves ordinary pages and the callback itself alone", () => {
    expect(strayAuthRedirect(u("/"))).toBeNull();
    expect(strayAuthRedirect(u("/audit?x=1"))).toBeNull();
    expect(strayAuthRedirect(u("/auth/callback?code=abc"))).toBeNull();
    expect(hasAuthParams(u("/?type=magiclink"))).toBe(false);
  });
});

describe("canonicalHostRedirect", () => {
  const prod = { APP_URL: "https://aeo-platform-kurby.vercel.app", VERCEL_ENV: "production" };

  it("sends an alias host to APP_URL with path and query intact", () => {
    const r = canonicalHostRedirect(new URL("https://aeo-platform-dusky.vercel.app/login?next=%2Fapp"), prod);
    expect(r?.toString()).toBe("https://aeo-platform-kurby.vercel.app/login?next=%2Fapp");
  });

  it("does nothing on the canonical host itself", () => {
    expect(canonicalHostRedirect(new URL("https://aeo-platform-kurby.vercel.app/app"), prod)).toBeNull();
  });

  it("leaves previews and local dev alone", () => {
    const u = new URL("https://aeo-platform-git-branch-kurby.vercel.app/login");
    expect(canonicalHostRedirect(u, { ...prod, VERCEL_ENV: "preview" })).toBeNull();
    expect(canonicalHostRedirect(new URL("http://localhost:3000/login"), { APP_URL: prod.APP_URL })).toBeNull();
  });

  it("ignores a missing or malformed APP_URL", () => {
    const u = new URL("https://aeo-platform-dusky.vercel.app/");
    expect(canonicalHostRedirect(u, { VERCEL_ENV: "production" })).toBeNull();
    expect(canonicalHostRedirect(u, { VERCEL_ENV: "production", APP_URL: "not a url" })).toBeNull();
  });
});
