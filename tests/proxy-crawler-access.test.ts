import { describe, expect, it } from "vitest";
import { AI_CRAWLERS } from "@/lib/audit/crawlers";
import { classifyProbe, probeCrawlerAccess, summarize, type CrawlerProbe } from "@/lib/proxy/crawler-access";
import { fakeFetch, type RecordedCall, type RouteSpec } from "./helpers/fake-fetch";

const PAGE = "<html><head><title>SSO vs SCIM</title></head><body>" + "real content ".repeat(200) + "</body></html>";
const URL_ = "https://acme.com/resources/sso-vs-scim";

describe("classifyProbe", () => {
  const h = (init: Record<string, string> = {}) => new Headers(init);
  it("maps status codes and challenge signatures to verdicts", () => {
    expect(classifyProbe({ status: 200, headers: h(), body: PAGE, baselineBytes: PAGE.length })).toEqual({ verdict: "allow", reason: "http 200" });
    expect(classifyProbe({ status: 403, headers: h({ server: "cloudflare" }), body: "", baselineBytes: PAGE.length }).verdict).toBe("block");
    expect(classifyProbe({ status: 429, headers: h(), body: "", baselineBytes: 0 }).verdict).toBe("challenge");
    expect(classifyProbe({ status: 503, headers: h(), body: "", baselineBytes: 0 }).verdict).toBe("challenge");
    expect(classifyProbe({ status: 200, headers: h({ "cf-mitigated": "challenge" }), body: PAGE, baselineBytes: PAGE.length }).verdict).toBe("challenge");
    expect(classifyProbe({ status: 200, headers: h(), body: "<title>Just a moment...</title><script src=/cdn-cgi/challenge-platform/>", baselineBytes: PAGE.length })).toMatchObject({ verdict: "challenge", reason: "challenge interstitial served with http 200" });
    expect(classifyProbe({ status: 200, headers: h(), body: "<html>Access denied</html>", baselineBytes: PAGE.length }).verdict).toBe("block");
    expect(classifyProbe({ status: 502, headers: h(), body: "", baselineBytes: 0 }).verdict).toBe("error");
    expect(classifyProbe({ status: null, headers: null, body: "", baselineBytes: 0, error: "timeout" })).toEqual({ verdict: "error", reason: "timeout" });
  });
});

describe("probeCrawlerAccess", () => {
  const wafRoute = (call: RecordedCall): RouteSpec => {
    const ua = call.userAgent ?? "";
    if (/GPTBot|ClaudeBot/.test(ua)) return { status: 403, body: "blocked", headers: { server: "cloudflare" } };
    if (/PerplexityBot/.test(ua)) return { status: 503, body: "" };
    if (/Bytespider/.test(ua)) return { status: 200, body: "<title>Just a moment...</title>" };
    return { status: 200, body: PAGE, headers: { "cache-control": "public, max-age=300" } };
  };

  it("probes once per crawler with that crawler's UA, classifies each, and folds in robots.txt", async () => {
    const ff = fakeFetch({ [URL_]: wafRoute });
    const robots = "User-agent: *\nDisallow: /private/\n\nUser-agent: CCBot\nDisallow: /\n";
    const report = await probeCrawlerAccess(URL_, { fetchImpl: ff.fetchImpl, allowPrivate: true, robotsTxt: robots, concurrency: 3, now: () => new Date("2026-09-03T00:00:00Z") });
    expect(report.probedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(report.baseline).toMatchObject({ status: 200, bytes: PAGE.length });
    expect(ff.calls).toHaveLength(AI_CRAWLERS.length + 1);
    expect(ff.calls[0]!.userAgent).toMatch(/^Mozilla\/5\.0 \(Macintosh/);
    expect(ff.calls.slice(1).map((c) => c.userAgent)).toEqual(AI_CRAWLERS.map((c) => `Mozilla/5.0 (compatible; ${c.userAgent}/1.0; +https://aeo.app/crawler-report)`));
    const by = Object.fromEntries(report.results.map((r) => [r.name, r]));
    expect(by.GPTBot).toMatchObject({ verdict: "block", status: 403, reason: "http 403 from cloudflare", robots: "allowed" });
    expect(by.PerplexityBot).toMatchObject({ verdict: "challenge", status: 503 });
    expect(by.Bytespider).toMatchObject({ verdict: "challenge", status: 200 });
    expect(by.CCBot).toMatchObject({ verdict: "allow", robots: "disallowed", robotsRule: "Disallow: /" });
    expect(by["ChatGPT-User"]).toMatchObject({ verdict: "allow", robots: "allowed" });
    expect(report.summary.tier1Blocked).toEqual(["GPTBot", "ClaudeBot", "PerplexityBot"]);
    expect(report.summary.robotsDisallowed).toEqual(["CCBot"]);
    expect(report.summary).toMatchObject({ blocked: 2, challenged: 2, errored: 0 });
    expect(report.summary.score).toBeLessThan(80);
  });

  it("reports robots as unknown without a robots.txt and scores a fully open edge 100", async () => {
    const ff = fakeFetch({ [URL_]: { body: PAGE } });
    const report = await probeCrawlerAccess(URL_, { fetchImpl: ff.fetchImpl, allowPrivate: true, crawlers: AI_CRAWLERS.slice(0, 3) });
    expect(report.results.every((r) => r.verdict === "allow" && r.robots === "unknown")).toBe(true);
    expect(report.summary.score).toBe(100);
    expect(report.summary.tier1Blocked).toEqual([]);
  });

  it("summarize weights tiers 70/20/10 and treats a robots disallow as unreachable", () => {
    const probe = (name: string, tier: 1 | 2 | 3, verdict: CrawlerProbe["verdict"], robots: CrawlerProbe["robots"] = "allowed"): CrawlerProbe => ({ name, userAgent: name, tier, operator: "x", purpose: "train", verdict, status: 200, reason: "", robots, robotsRule: null, durationMs: 1 });
    const s = summarize([probe("a", 1, "allow"), probe("b", 1, "allow", "disallowed"), probe("c", 2, "block"), probe("d", 3, "allow")]);
    expect(s.score).toBe(45);
    expect(s.tier1Blocked).toEqual(["b"]);
  });
});
