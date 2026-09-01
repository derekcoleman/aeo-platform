import { describe, expect, it } from "vitest";
import { MAX_HOPS, decideProxyAction, type SiteRoute } from "@/lib/tenancy";

const site: SiteRoute = {
  id: "site-1",
  orgId: "org-1",
  canonicalDomain: "acme.com",
  pathPrefix: "/resources",
  edgeHostname: "acme-8fj2.blogedge.aeo.app",
  proxyMode: "cloudflare_worker",
  trailingSlash: "never",
  locale: "en-US",
  status: "active",
  allowedHosts: ["acme.com", "www.acme.com"],
};

const input = (over: Partial<Parameters<typeof decideProxyAction>[0]> = {}) =>
  decideProxyAction({
    host: site.edgeHostname,
    forwardedHost: "acme.com",
    pathname: "/resources/hello",
    hops: "1",
    site,
    ...over,
  });

describe("loop detection", () => {
  it("allows the normal two-hop path", () => {
    expect(input({ hops: String(MAX_HOPS) }).kind).toBe("render");
  });

  it("508s past the hop limit", () => {
    expect(input({ hops: String(MAX_HOPS + 1) })).toEqual({ kind: "loop", status: 508 });
  });

  it("508s when the forwarded host is one of ours", () => {
    // Customer pointed their rewrite at the edge hostname instead of their own
    // domain — following it would spin forever.
    expect(input({ forwardedHost: "acme-8fj2.blogedge.aeo.app" })).toEqual({
      kind: "loop",
      status: 508,
    });
  });

  it("checks for loops before touching the site, so a loop stays cheap", () => {
    expect(input({ site: null, hops: "9" }).kind).toBe("loop");
  });

  it("treats an unparseable hop count as zero rather than failing open", () => {
    expect(input({ hops: "not-a-number" }).kind).toBe("render");
  });
});

describe("passthrough", () => {
  it("404s an unknown host with the passthrough marker", () => {
    expect(input({ site: null })).toEqual({ kind: "passthrough", status: 404 });
  });

  it("404s paths outside the site's subtree", () => {
    expect(input({ pathname: "/pricing" }).kind).toBe("passthrough");
  });

  it("does not claim a sibling prefix", () => {
    // /resources-archive is the customer's page, not ours.
    expect(input({ pathname: "/resources-archive/x" }).kind).toBe("passthrough");
  });
});

describe("trailing slash", () => {
  it("redirects root-relatively, never to our edge host", () => {
    const a = input({ pathname: "/resources/hello/" });
    expect(a).toEqual({ kind: "redirect", status: 301, location: "/resources/hello" });
    if (a.kind === "redirect") expect(a.location.startsWith("/")).toBe(true);
  });

  it("does not bounce the prefix root", () => {
    expect(input({ pathname: "/resources/" }).kind).toBe("render");
  });
});

describe("render", () => {
  it("rewrites to the tenant-scoped internal path", () => {
    const a = input();
    expect(a).toMatchObject({
      kind: "render",
      siteId: "site-1",
      internalPath: "/render/site-1/resources/hello",
      canonicalDomain: "acme.com",
      indexable: true,
    });
  });

  it("keeps the public prefix in the public url and the tenant id internal", () => {
    const a = input({ forwardedHost: "www.acme.com" });
    if (a.kind !== "render") throw new Error("expected render");
    expect(a.internalPath).toContain("/resources/hello");
    expect(a.canonicalDomain).toBe("www.acme.com");
  });

  it("renders but refuses indexing for an unverified forwarded host", () => {
    const a = input({ forwardedHost: "evil.example" });
    expect(a).toMatchObject({ kind: "render", indexable: false, canonicalDomain: "acme.com" });
  });

  it("refuses indexing on a direct hit to the edge host", () => {
    expect(input({ forwardedHost: null })).toMatchObject({ kind: "render", indexable: false });
  });

  it("refuses indexing for a paused site", () => {
    expect(input({ site: { ...site, status: "paused" } })).toMatchObject({
      kind: "render",
      indexable: false,
    });
  });
});
