import { describe, expect, it } from "vitest";
import type { HealthSite } from "@/lib/proxy/health";
import { runPreflight, sitemapUrlsUnderPrefix } from "@/lib/proxy/preflight";
import { fakeFetch, type RecordedCall, type RouteSpec } from "./helpers/fake-fetch";

const site: HealthSite = { id: "aaaaaaaa-0000-0000-0000-000000000001", canonicalDomain: "acme.com", pathPrefix: "/resources", edgeHostname: "acme-8fj2.blogedge.aeo.app", proxyMode: "cloudflare_worker", trailingSlash: "never" };
const health = (call: RecordedCall): RouteSpec => ({ status: 200, headers: { "content-type": "application/json", "x-aeo-site": site.id }, body: JSON.stringify({ ok: true, siteId: site.id, nonce: new URL(call.url).searchParams.get("nonce"), received: { forwardedHost: "acme.com", hops: "1", indexable: false, sawCookie: false, sawAuthorization: false } }) });
const PAGE = '<html><head><link rel="canonical" href="https://acme.com/resources/ours"></head><body>' + "content ".repeat(100) + "</body></html>";

const base = () => ({
  "https://acme.com/robots.txt": { body: "User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://acme.com/sitemap.xml\nSitemap: https://acme.com/resources/sitemap.xml\n" },
  "https://acme.com/sitemap.xml": { body: "<urlset><url><loc>https://acme.com/pricing</loc></url><url><loc>https://acme.com/about</loc></url></urlset>", headers: { "content-type": "application/xml" } },
  "https://acme.com/resources/sitemap.xml": { body: "<urlset><url><loc>https://acme.com/resources/ours</loc></url></urlset>", headers: { "content-type": "application/xml" } },
  "https://acme.com/resources/aeo-health*": health,
  "https://acme.com/resources/aeo-health": health,
});

describe("sitemapUrlsUnderPrefix", () => {
  it("follows robots Sitemap lines and one level of index, ignores our own sitemap under the prefix, and returns only prefix hits", async () => {
    const ff = fakeFetch({
      ...base(),
      "https://acme.com/sitemap.xml": { body: "<sitemapindex><sitemap><loc>https://acme.com/pages.xml</loc></sitemap><sitemap><loc>https://acme.com/resources/sitemap.xml</loc></sitemap></sitemapindex>", headers: { "content-type": "application/xml" } },
      "https://acme.com/pages.xml": { body: "<urlset><url><loc>https://acme.com/resources/old-post</loc></url><url><loc>https://acme.com/resources-archive/x</loc></url><loc>https://other.com/resources/y</loc></urlset>", headers: { "content-type": "application/xml" } },
    });
    const hits = await sitemapUrlsUnderPrefix("https://acme.com", "/resources", ["https://acme.com/sitemap.xml"], { fetchImpl: ff.fetchImpl, allowPrivate: true });
    expect(hits).toEqual(["https://acme.com/resources/old-post"]);
    expect(ff.callsTo("https://acme.com/resources/sitemap.xml")).toHaveLength(0);
  });
});

describe("runPreflight", () => {
  it("passes a clean install: no collision, health green, robots + live crawler report attached", async () => {
    const ff = fakeFetch({ ...base(), "https://acme.com/resources/ours": { body: PAGE }, "https://acme.com/resources/ours/": { status: 301, headers: { location: "/resources/ours" } } });
    const r = await runPreflight(site, { fetchImpl: ff.fetchImpl, allowPrivate: true, articlePath: "/resources/ours", concurrency: 6, nonce: () => "n" });
    expect(r.blocking).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.collisions).toMatchObject({ occupied: false, sitemapUrls: [], probe: { status: 200, ours: true } });
    expect(r.robots.crawlers.find((c) => c.name === "GPTBot")!.allowed).toBe(false);
    expect(r.crawlerAccess!.url).toBe("https://acme.com/resources/ours");
    expect(r.crawlerAccess!.results.find((p) => p.name === "GPTBot")).toMatchObject({ verdict: "allow", robots: "disallowed" });
    expect(r.crawlerAccess!.summary.tier1Blocked).toEqual(["GPTBot"]);
    expect(r.checks.find((c) => c.key === "ai_crawlers")).toMatchObject({ ok: false, severity: "warn" });
  });

  it("blocks on a path collision from their sitemap and on their page occupying the prefix", async () => {
    const ff = fakeFetch({
      ...base(),
      "https://acme.com/sitemap.xml": { body: "<urlset><url><loc>https://acme.com/resources/whitepaper</loc></url></urlset>", headers: { "content-type": "application/xml" } },
      "https://acme.com/resources/aeo-health": { status: 200, body: "<html>their 200 catch-all</html>" },
      "https://acme.com/resources/aeo-health*": { status: 200, body: "<html>their 200 catch-all</html>" },
    });
    const r = await runPreflight(site, { fetchImpl: ff.fetchImpl, allowPrivate: true, crawlerReport: false });
    expect(r.ok).toBe(false);
    expect(r.installed).toBe(false);
    expect(r.collisions).toMatchObject({ occupied: true, sitemapUrls: ["https://acme.com/resources/whitepaper"] });
    expect(r.blocking).toEqual([
      "/resources already serves one of their pages; choose another prefix or move it",
      "1 URL(s) in their sitemap live under /resources",
      "the rewrite for /resources does not reach us (http 200)",
    ]);
    expect(r.crawlerAccess).toBeNull();
  });

  it("blocks when the rewrite is not installed (404 on the prefix) without running the crawler probe", async () => {
    const ff = fakeFetch({ ...base(), "https://acme.com/resources/aeo-health": { status: 404 }, "https://acme.com/resources/aeo-health*": { status: 404 }, "https://acme.com/resources/sitemap.xml": { status: 404 } });
    const r = await runPreflight(site, { fetchImpl: ff.fetchImpl, allowPrivate: true });
    expect(r.installed).toBe(false);
    expect(r.blocking[0]).toBe("the rewrite for /resources does not reach us (http 404)");
    expect(r.blocking).not.toContain("health check failed: health_endpoint");
    expect(r.crawlerAccess).toBeNull();
    expect(ff.calls.filter((c) => /GPTBot/.test(c.userAgent ?? ""))).toHaveLength(0);
  });
});
