import { describe, expect, it } from "vitest";
import { htmlToMarkdown, parseHtml } from "@/lib/audit/html";
import { PAGE_RULES, RULE_REGISTRY_VERSION, runPageRules, runSiteRules, type PageInput } from "@/lib/aeo/rules";
import type { SiteRuleInput } from "@/lib/aeo/rules/site";

const ARTICLE = `<!doctype html><html><head><title>SSO vs SCIM</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"SSO vs SCIM","author":{"@type":"Person","name":"Jane Doe"},"datePublished":"2026-08-01","dateModified":"2026-08-20"}</script>
</head><body><article>
<h1>What is the difference between SSO and SCIM?</h1>
<p>SSO lets a user sign in once and reach every connected app, while SCIM automatically creates, updates and removes those user accounts across apps. Most mid-market teams need both, and 63% of buyers ask about them together, according to Okta.</p>
<h2>What does SSO actually do?</h2>
<p>Single sign-on delegates authentication to one identity provider so employees authenticate once and every integrated application trusts that session instead of keeping its own password.</p>
<h2>What does SCIM add on top?</h2>
<p>SCIM is a provisioning protocol: when HR adds or removes someone, the identity provider pushes that change to each application so accounts appear and disappear without a ticket.</p>
<h2>How do they compare?</h2>
<table><tr><th>Feature</th><th>SSO</th><th>SCIM</th></tr><tr><td>Login</td><td>Yes</td><td>No</td></tr></table>
<p>SSO handles who can log in; SCIM handles whether the account exists at all, which is why 41% of security reviews require both, per Gartner.</p>
<h2>FAQ</h2>
<h3>Do I need SCIM if I have SSO?</h3><p>Yes if you want offboarding to be automatic rather than manual.</p>
<h3>Does SCIM require SSO?</h3><p>No, but nearly every identity provider bundles them and buyers expect both.</p>
<h3>How long does SCIM take to set up?</h3><p>Usually one afternoon per application once the identity provider is configured.</p>
<p>Written by <a rel="author" href="/authors/jane">Jane Doe</a>, identity lead.</p>
</article></body></html>`;

function input(html: string, extra: Partial<PageInput> = {}): PageInput {
  const $ = parseHtml(html);
  return { url: "https://acme.com/resources/sso-vs-scim", html, $, markdown: htmlToMarkdown(html), now: new Date("2026-09-01"), ...extra };
}

describe("page rules", () => {
  it("has unique keys and a version stamp", () => {
    const keys = PAGE_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(RULE_REGISTRY_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/);
  });

  it("every finding stays within [0, maxScore] and normalized within [0, 100]", () => {
    for (const html of [ARTICLE, "<html><body><p>hi</p></body></html>", ""]) {
      const s = runPageRules(input(html));
      for (const f of s.findings) {
        expect(f.score).toBeGreaterThanOrEqual(0);
        expect(f.score).toBeLessThanOrEqual(f.maxScore);
      }
      expect(s.normalized).toBeGreaterThanOrEqual(0);
      expect(s.normalized).toBeLessThanOrEqual(100);
    }
  });

  // The invariant the shared-registry design rests on: the audit (headers
  // present) and the pipeline linter (no headers) score the same HTML the same.
  it("audit and linter consumers score identical HTML identically", () => {
    const audit = runPageRules(input(ARTICLE, { headers: new Headers({ "content-type": "text/html", "last-modified": "Mon, 20 Aug 2026 00:00:00 GMT" }) }));
    const linter = runPageRules(input(ARTICLE));
    expect(linter.findings.map((f) => [f.key, f.score, f.passed])).toEqual(audit.findings.map((f) => [f.key, f.score, f.passed]));
    expect(linter.normalized).toBe(audit.normalized);
  });

  it("a well-structured article beats a bare page", () => {
    const good = runPageRules(input(ARTICLE));
    const bad = runPageRules(input("<html><body><h1>Title</h1><p>Short.</p></body></html>"));
    expect(good.normalized).toBeGreaterThan(bad.normalized);
    const byKey = Object.fromEntries(good.findings.map((f) => [f.key, f]));
    expect(byKey.question_headings!.passed).toBe(true);
    expect(byKey.comparison_table!.passed).toBe(true);
    expect(byKey.faq_block!.passed).toBe(true);
  });

  it("comparison_table is not applicable to non-comparative intent without a table", () => {
    const s = runPageRules(input("<html><body><h1>How do I set up SSO?</h1><p>Step one.</p></body></html>", { intent: "howto" }));
    const f = s.findings.find((x) => x.key === "comparison_table")!;
    expect(f.notApplicable).toBe(true);
  });

  it("is deterministic", () => {
    expect(runPageRules(input(ARTICLE))).toEqual(runPageRules(input(ARTICLE)));
  });
});

describe("site rules", () => {
  const base: SiteRuleInput = { crawlerAccess: null, schema: null, citability: null, eeat: null, technical: null, platformReadiness: null, llmsTxt: null };

  it("produces nothing for modules that did not run", () => {
    expect(runSiteRules(base)).toEqual([]);
  });

  it("flags a missing llms.txt and a blocked tier-1 crawler with stable keys", () => {
    const recs = runSiteRules({
      ...base,
      llmsTxt: { found: false, url: "https://a.com/llms.txt", valid: false, sections: [], issues: [] },
      crawlerAccess: {
        robotsTxtFound: true, robotsTxtUrl: "u", robotsTxtStatus: 200, tier1Score: 50, tier2Score: 100,
        blanketBlockDetected: false, pathBlocks: [], aiSpecificFilesPresent: false, totalScore: 60,
        crawlers: [{ name: "GPTBot", userAgent: "GPTBot", tier: 1, allowed: false, rule: "Disallow: /", paths: [{ path: "/", allowed: false, rule: "Disallow: /" }] }],
      },
    });
    const keys = recs.map((r) => r.ruleKey);
    expect(keys).toContain("llms_txt.missing");
    expect(keys).toContain("crawler.gptbot_blocked");
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of recs) expect(["critical", "high", "medium", "low"]).toContain(r.priority);
  });
});
