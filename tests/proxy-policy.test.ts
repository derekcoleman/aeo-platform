import { describe, expect, it } from "vitest";
import { INTERNAL_HEADER, MAX_HOPS, decideProxyAction, isReservedPath, renderRequestHeaders, type SiteRoute } from "@/lib/tenancy";
import { NOINDEX_CACHE_CONTROL, textResponse } from "@/lib/render/routes";

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

  it("508s when a DIFFERENT edge host was forwarded to us", () => {
    // Someone pointed a rewrite at an edge hostname instead of their own
    // domain — following it would spin forever. Note this must be a different
    // host than the one the request arrived on; see the defaulting tests below
    // for why equality is a direct hit rather than a loop.
    expect(input({ forwardedHost: "other-9xyz.blogedge.aeo.app" })).toEqual({
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
  it("asks the handler to redirect, root-relatively and never to our edge host", () => {
    const a = input({ pathname: "/resources/hello/" });
    expect(a).toMatchObject({ kind: "render", redirectTo: "/resources/hello" });
    // Root-relative is the point: middleware cannot emit it (Next parses
    // Location as absolute and throws), so the handler does.
    if (a.kind === "render") expect(a.redirectTo?.startsWith("/")).toBe(true);
  });

  it("rewrites to the normalised path, so the handler resolves the right page", () => {
    const a = input({ pathname: "/resources/hello/" });
    expect(a).toMatchObject({ internalPath: "/render/site-1/resources/hello" });
  });

  it("does not bounce the prefix root", () => {
    const a = input({ pathname: "/resources/" });
    expect(a.kind).toBe("render");
    if (a.kind === "render") expect(a.redirectTo).toBeUndefined();
  });

  it("leaves an already-correct path alone", () => {
    const a = input({ pathname: "/resources/hello" });
    if (a.kind === "render") expect(a.redirectTo).toBeUndefined();
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

describe("x-forwarded-host defaulting to the request host", () => {
  // Servers (Next included) populate x-forwarded-host from Host when nothing
  // upstream set it. Before this was handled, every direct request to an edge
  // hostname — health checks included — came back 508.
  it("treats a self-referential forwarded host as a direct hit, not a loop", () => {
    const a = input({ forwardedHost: site.edgeHostname, hops: null });
    expect(a.kind).toBe("render");
  });

  it("still refuses to index a direct hit", () => {
    expect(input({ forwardedHost: site.edgeHostname, hops: null })).toMatchObject({
      kind: "render",
      indexable: false,
      canonicalDomain: "acme.com",
    });
  });

  it("still detects a genuine loop: a DIFFERENT edge host forwarded to us", () => {
    expect(input({ forwardedHost: "other-9xyz.blogedge.aeo.app" })).toEqual({
      kind: "loop",
      status: 508,
    });
  });

  it("passes through paths outside the prefix on a direct hit", () => {
    expect(input({ pathname: "/pricing", forwardedHost: site.edgeHostname }).kind).toBe(
      "passthrough",
    );
  });
});

describe("render request headers", () => {
  it("drops every x-aeo-internal-* header a client sent, whatever its case", () => {
    const incoming = new Headers({
      "X-AEO-Internal-Redirect": "https://evil.example/",
      "x-aeo-internal-indexable": "1",
      "X-Aeo-Internal-Canonical-Domain": "evil.example",
      "x-aeo-internal-whatever-comes-next": "1",
      "X-AEO-Worker-Version": "99",
      cookie: "session=secret",
      Authorization: "Bearer x",
      "Proxy-Authorization": "Basic x",
    });
    const out = renderRequestHeaders(incoming);
    const names = [...out.keys()];
    expect(names.filter((n) => n.startsWith("x-aeo-internal-"))).toEqual([]);
    for (const h of ["x-aeo-worker-version", "cookie", "authorization", "proxy-authorization"]) expect(out.has(h), h).toBe(false);
    expect(out.get(INTERNAL_HEADER.redirect)).toBeNull();
  });

  it("keeps everything else, including the proxy's own hop count and signature", () => {
    const out = renderRequestHeaders(new Headers({ "user-agent": "GPTBot/1.2", "x-forwarded-host": "acme.com", "x-aeo-hops": "1", "x-aeo-sig": "abc", accept: "text/html" }));
    expect(Object.fromEntries(out)).toEqual({ "user-agent": "GPTBot/1.2", "x-forwarded-host": "acme.com", "x-aeo-hops": "1", "x-aeo-sig": "abc", accept: "text/html" });
  });

  it("does not mutate the request's own headers", () => {
    const incoming = new Headers({ "x-aeo-internal-indexable": "1" });
    renderRequestHeaders(incoming);
    expect(incoming.get("x-aeo-internal-indexable")).toBe("1");
  });
});

describe("reserved paths", () => {
  it("recognises the internal route however it is spelled", () => {
    for (const p of ["/render", "/render/x", "/%72ender/x", "//render/x", "/RENDER/x", "/render%2Fx"]) expect(isReservedPath(p), p).toBe(true);
    for (const p of ["/renderer", "/resources/render", "/%zz", "/"]) expect(isReservedPath(p), p).toBe(false);
  });

  it("is passed through on an edge host however it is spelled", () => {
    expect(input({ pathname: "/%72ender/site-1/resources/hello" }).kind).toBe("passthrough");
  });
});

describe("render response caching", () => {
  it("lets a shared cache keep an indexable response, varied on the forwarded host", () => {
    const res = textResponse("<p>ok</p>", "text/html; charset=utf-8", { etag: '"e1"' }, { indexable: true });
    expect(res.headers.get("cache-control")).toMatch(/^public, .*s-maxage=300/);
    expect(res.headers.get("vary")).toBe("X-Forwarded-Host");
    expect(res.headers.get("etag")).toBe('"e1"');
  });

  it("never lets a shared cache keep a noindex response, whatever the caller asked for", () => {
    const res = textResponse("User-agent: *", "text/plain", { "cache-control": "public, max-age=300" }, { indexable: false });
    expect(res.headers.get("cache-control")).toBe(NOINDEX_CACHE_CONTROL);
    expect(res.headers.get("vary")).toBe("X-Forwarded-Host");
  });
});
