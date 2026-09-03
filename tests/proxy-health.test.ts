import { describe, expect, it } from "vitest";
import { canonicalHrefOf, cspAllowsInlineStyle, robotsMetaOf, runHealthCheck, type HealthSite } from "@/lib/proxy/health";
import { fakeFetch, type RecordedCall, type RouteSpec } from "./helpers/fake-fetch";

const site: HealthSite = { id: "aaaaaaaa-0000-0000-0000-000000000001", canonicalDomain: "acme.com", pathPrefix: "/resources", edgeHostname: "acme-8fj2.blogedge.aeo.app", proxyMode: "cloudflare_worker", trailingSlash: "never" };
const ARTICLE = "https://acme.com/resources/sso-vs-scim";
const nonce = () => "n0nce";

function healthRoute(overrides: Partial<{ sawCookie: boolean; forwardedHost: string | null; indexable: boolean; siteId: string; nonce: string | null; headers: Record<string, string> }> = {}) {
  return (call: RecordedCall): RouteSpec => ({
    status: 200,
    headers: { "content-type": "application/json", "x-aeo-site": overrides.siteId ?? site.id, ...(overrides.headers ?? {}) },
    body: JSON.stringify({
      ok: true,
      siteId: overrides.siteId ?? site.id,
      nonce: overrides.nonce === undefined ? new URL(call.url).searchParams.get("nonce") : overrides.nonce,
      received: { forwardedHost: overrides.forwardedHost === undefined ? "acme.com" : overrides.forwardedHost, hops: "1", indexable: overrides.indexable ?? true, sawCookie: overrides.sawCookie ?? false, sawAuthorization: false },
    }),
  });
}
const article = (extra: Partial<RouteSpec> = {}): RouteSpec => ({ status: 200, headers: { "cache-control": "public, max-age=0, s-maxage=300", ...(extra.headers ?? {}) }, body: extra.body ?? `<html><head><link rel="canonical" href="${ARTICLE}"><meta name="robots" content="index,follow"></head><body><style>:root{}</style><p>hi</p></body></html>` });
const good = () => ({
  "https://acme.com/resources/aeo-health?nonce=n0nce": healthRoute(),
  [ARTICLE]: article(),
  [`${ARTICLE}/`]: { status: 301, headers: { location: "/resources/sso-vs-scim" } },
  "https://acme.com/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://acme.com/resources/sitemap.xml\n" },
  "https://acme.com/resources/sitemap.xml": { body: `<urlset><url><loc>${ARTICLE}</loc></url></urlset>`, headers: { "content-type": "application/xml" } },
});

describe("helpers", () => {
  it("cspAllowsInlineStyle reads style-src, falls back to default-src, accepts nonces and hashes", () => {
    expect(cspAllowsInlineStyle(null)).toEqual({ allows: true, directive: null });
    expect(cspAllowsInlineStyle("default-src 'self'; style-src 'self' 'unsafe-inline'").allows).toBe(true);
    expect(cspAllowsInlineStyle("default-src 'self'")).toEqual({ allows: false, directive: "default-src self" });
    expect(cspAllowsInlineStyle("style-src 'self' 'nonce-abc'").allows).toBe(true);
    expect(cspAllowsInlineStyle("style-src 'sha256-xyz'").allows).toBe(true);
    expect(cspAllowsInlineStyle("script-src 'self'").allows).toBe(true);
  });

  it("canonicalHrefOf / robotsMetaOf tolerate attribute order", () => {
    expect(canonicalHrefOf('<link href="https://a.com/x" rel="canonical">')).toBe("https://a.com/x");
    expect(robotsMetaOf('<meta content="noindex" name="robots">')).toBe("noindex");
    expect(canonicalHrefOf("<p>none</p>")).toBeNull();
  });
});

describe("runHealthCheck", () => {
  it("passes a healthy install, sends a cookie and a token on the probe, and reports the TTFB", async () => {
    const ff = fakeFetch(good());
    const r = await runHealthCheck(site, { fetchImpl: ff.fetchImpl, allowPrivate: true, articlePath: "/resources/sso-vs-scim", expectIndexable: true, nonce });
    expect(r.failed).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(typeof r.ttfbMs).toBe("number");
    const probe = ff.callsTo("https://acme.com/resources/aeo-health?nonce=n0nce")[0]!;
    expect(probe.headers.cookie).toBe("aeo_probe=1");
    expect(probe.headers.authorization).toBe("Bearer aeo-probe");
    expect(r.checks.map((c) => c.key)).toEqual(["health_endpoint", "site_header", "nonce_echo", "cookie_stripped", "forwarded_host", "indexable", "hops", "csp_inline_style", "crawl_coverage", "article", "no_edge_hostname", "canonical", "not_noindex", "no_set_cookie", "cache_control_kept", "redirect_depth", "sitemap_line", "sitemap"]);
  });

  it("fails when the edge answers with someone else's site, a stale nonce, or leaks cookies", async () => {
    const other = await runHealthCheck(site, { fetchImpl: fakeFetch({ ...good(), "https://acme.com/resources/aeo-health?nonce=n0nce": healthRoute({ siteId: "bbbbbbbb-0000-0000-0000-000000000002" }) }).fetchImpl, allowPrivate: true, nonce });
    expect(other.failed).toContain("health_endpoint");
    const stale = await runHealthCheck(site, { fetchImpl: fakeFetch({ ...good(), "https://acme.com/resources/aeo-health?nonce=n0nce": healthRoute({ nonce: "old" }) }).fetchImpl, allowPrivate: true, nonce });
    expect(stale.failed).toEqual(["nonce_echo"]);
    const cookie = await runHealthCheck(site, { fetchImpl: fakeFetch({ ...good(), "https://acme.com/resources/aeo-health?nonce=n0nce": healthRoute({ sawCookie: true }) }).fetchImpl, allowPrivate: true, nonce });
    expect(cookie.failed).toEqual(["cookie_stripped"]);
    // A Vercel rewrite cannot strip cookies at their edge; that is disclosed at install, so here it is a warning.
    const vercel = await runHealthCheck({ ...site, proxyMode: "vercel_rewrite" }, { fetchImpl: fakeFetch({ ...good(), "https://acme.com/resources/aeo-health?nonce=n0nce": healthRoute({ sawCookie: true }) }).fetchImpl, allowPrivate: true, nonce });
    expect(vercel.ok).toBe(true);
    expect(vercel.warnings).toEqual(expect.arrayContaining(["cookie_stripped", "crawl_coverage"]));
  });

  it("flags a missing forwarded host, a restrictive CSP applied by their edge, and a redirect chain", async () => {
    const routes = {
      ...good(),
      "https://acme.com/resources/aeo-health?nonce=n0nce": healthRoute({ forwardedHost: null, indexable: false, headers: { "content-security-policy": "default-src 'self'; style-src 'self'" } }),
      [`${ARTICLE}/`]: { status: 301, headers: { location: "/resources/sso-vs-scim/index" } },
      "https://acme.com/resources/sso-vs-scim/index": { status: 302, headers: { location: ARTICLE } },
    };
    const r = await runHealthCheck(site, { fetchImpl: fakeFetch(routes).fetchImpl, allowPrivate: true, articlePath: "/resources/sso-vs-scim", expectIndexable: true, nonce });
    expect(r.failed).toEqual(["forwarded_host", "indexable", "csp_inline_style", "redirect_depth"]);
    expect(r.checks.find((c) => c.key === "csp_inline_style")!.detail.directive).toBe("style-src self");
  });

  it("catches an edge-hostname leak, a wrong canonical, a set-cookie, and a missing sitemap line", async () => {
    const routes = {
      ...good(),
      [ARTICLE]: article({ body: '<html><head><link rel="canonical" href="https://acme-8fj2.blogedge.aeo.app/resources/sso-vs-scim"></head><body></body></html>', headers: { "set-cookie": "s=1" } }),
      "https://acme.com/robots.txt": { body: "User-agent: *\nAllow: /\n" },
    };
    const r = await runHealthCheck(site, { fetchImpl: fakeFetch(routes).fetchImpl, allowPrivate: true, articlePath: "/resources/sso-vs-scim", nonce });
    expect(r.failed).toEqual(["no_edge_hostname", "canonical", "no_set_cookie"]);
    expect(r.warnings).toEqual(["sitemap_line"]);
  });

  it("an unreachable health endpoint is one failure with the error, and a TLS error is named as such", async () => {
    const ff = fakeFetch({ ...good(), "https://acme.com/resources/aeo-health?nonce=n0nce": { status: 404, body: "" } });
    const r = await runHealthCheck(site, { fetchImpl: ff.fetchImpl, allowPrivate: true, nonce });
    expect(r.failed).toEqual(["health_endpoint"]);
    expect(r.checks[0]!.detail).toMatchObject({ status: 404 });
    const tls = (async () => { throw new Error("unable to verify the first certificate"); }) as unknown as typeof fetch;
    const t = await runHealthCheck(site, { fetchImpl: tls, allowPrivate: true, nonce });
    expect(t.failed).toContain("tls");
  });
});
