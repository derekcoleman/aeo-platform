import { describe, expect, it } from "vitest";
import { evaluatePath, hasBlanketBlock, isCrawlerAllowed, parseRobotsTxt } from "@/lib/audit/robots";
import { AI_CRAWLERS, evaluateCrawlerAccess } from "@/lib/audit/crawlers";

const ROBOTS = `
# comment
User-agent: *
Disallow: /admin/
Allow: /admin/public

User-agent: GPTBot
Disallow: /blog/

User-agent: ClaudeBot
User-agent: PerplexityBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`;

describe("parseRobotsTxt", () => {
  it("groups consecutive user-agents and collects sitemaps", () => {
    const r = parseRobotsTxt(ROBOTS);
    expect(r.groups).toHaveLength(3);
    expect(r.groups[2]!.agents).toEqual(["claudebot", "perplexitybot"]);
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("ignores empty Disallow", () => {
    const r = parseRobotsTxt("User-agent: *\nDisallow:\n");
    expect(r.groups[0]!.rules).toEqual([]);
    expect(isCrawlerAllowed(r, "GPTBot")).toBe(true);
  });
});

describe("evaluatePath — path-level, not root-only", () => {
  const r = parseRobotsTxt(ROBOTS);

  // The regression that motivated the port: gtm-agents only evaluated `/`,
  // so `Disallow: /blog/` for GPTBot read as fully allowed.
  it("GPTBot is allowed at root but blocked under /blog/", () => {
    expect(isCrawlerAllowed(r, "GPTBot", "/")).toBe(true);
    expect(isCrawlerAllowed(r, "GPTBot", "/blog/post")).toBe(false);
    expect(evaluatePath(r, "GPTBot", "/blog/post").rule?.line).toBe("Disallow: /blog/");
  });

  it("longest match wins, allow beats disallow on ties", () => {
    expect(isCrawlerAllowed(r, "Googlebot", "/admin/secret")).toBe(false);
    expect(isCrawlerAllowed(r, "Googlebot", "/admin/public/x")).toBe(true);
  });

  it("falls back to * when no specific group matches", () => {
    const v = evaluatePath(r, "OAI-SearchBot", "/admin/x");
    expect(v.allowed).toBe(false);
    expect(v.unmatched).toBe(false);
  });

  it("is unmatched with no groups at all", () => {
    expect(evaluatePath(parseRobotsTxt(""), "GPTBot", "/")).toEqual({ allowed: true, rule: null, unmatched: true });
  });

  it("supports * and $ wildcards", () => {
    const w = parseRobotsTxt("User-agent: *\nDisallow: /*.pdf$\n");
    expect(isCrawlerAllowed(w, "x", "/a/b.pdf")).toBe(false);
    expect(isCrawlerAllowed(w, "x", "/a/b.pdf?x=1")).toBe(true);
  });
});

describe("hasBlanketBlock", () => {
  it("detects User-agent: * Disallow: /", () => {
    expect(hasBlanketBlock(parseRobotsTxt("User-agent: *\nDisallow: /\n"))).toBe(true);
    expect(hasBlanketBlock(parseRobotsTxt(ROBOTS))).toBe(false);
  });
});

describe("evaluateCrawlerAccess", () => {
  it("reports per-path verdicts and path blocks for the content prefix", () => {
    const res = evaluateCrawlerAccess({
      robotsTxtUrl: "https://example.com/robots.txt",
      robotsTxtStatus: 200,
      robotsTxtBody: ROBOTS,
      paths: ["/blog/"],
      aiSpecificFilesPresent: false,
    });
    const gpt = res.crawlers.find((c) => c.name === "GPTBot")!;
    expect(gpt.allowed).toBe(true);
    expect(gpt.paths.find((p) => p.path === "/blog/")!.allowed).toBe(false);
    // `/` is partially blocked too (ClaudeBot/PerplexityBot), so it is listed; the
    // regression is that `/blog/` appears at all and names GPTBot.
    const blog = res.pathBlocks.find((p) => p.path === "/blog/")!;
    expect(blog.crawlers).toContain("GPTBot");
    expect(res.pathBlocks.find((p) => p.path === "/")!.crawlers).not.toContain("GPTBot");
    const claude = res.crawlers.find((c) => c.name === "ClaudeBot")!;
    expect(claude.allowed).toBe(false);
    expect(res.tier1Score).toBeLessThan(100);
    expect(res.robotsTxtFound).toBe(true);
  });

  it("treats a missing robots.txt as fully open", () => {
    const res = evaluateCrawlerAccess({ robotsTxtUrl: "u", robotsTxtStatus: 404, robotsTxtBody: null, paths: [], aiSpecificFilesPresent: false });
    expect(res.robotsTxtFound).toBe(false);
    expect(res.crawlers.every((c) => c.allowed)).toBe(true);
    expect(res.crawlers).toHaveLength(AI_CRAWLERS.length);
  });
});
