import type { AuditResult } from "@/lib/audit/types";
import type { SiteRecommendation } from "./types";

/**
 * Site-level rules: each looks at the audit's dimension results and emits a
 * recommendation when its condition holds. Ported from gtm-agents'
 * generateRecommendations, split into named rules with stable keys so runs
 * can be diffed ("what changed since last month").
 */

export type SiteRuleInput = Pick<AuditResult, "crawlerAccess" | "schema" | "citability" | "eeat" | "technical" | "platformReadiness" | "llmsTxt">;

export interface SiteRule {
  key: string;
  evaluate(a: SiteRuleInput): SiteRecommendation | null;
}

const rec = (r: SiteRecommendation) => r;

function crawler(a: SiteRuleInput, name: string) {
  return a.crawlerAccess?.crawlers.find((c) => c.name === name);
}

function blockedAnywhere(a: SiteRuleInput, name: string): { blocked: boolean; paths: string[]; rule: string | null } {
  const c = crawler(a, name);
  if (!c) return { blocked: false, paths: [], rule: null };
  const paths = c.paths.filter((p) => !p.allowed);
  return { blocked: paths.length > 0, paths: paths.map((p) => p.path), rule: paths[0]?.rule ?? null };
}

function crawlerBlockRule(name: string, priority: SiteRecommendation["priority"], why: string): SiteRule {
  return {
    key: `crawler.${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_blocked`,
    evaluate(a) {
      const b = blockedAnywhere(a, name);
      if (!b.blocked) return null;
      const scope = b.paths.includes("/") ? "site-wide" : `on ${b.paths.join(", ")}`;
      return rec({
        ruleKey: this.key,
        category: "crawler_access",
        priority,
        title: `${name} is blocked ${scope}`,
        description: `robots.txt disallows ${name}${b.rule ? ` via \`${b.rule}\`` : ""}. ${why}`,
        impact: "Content cannot be discovered or cited by this platform.",
        evidence: { crawler: name, paths: b.paths, rule: b.rule },
      });
    },
  };
}

export const SITE_RULES: SiteRule[] = [
  // --- crawler access ---
  crawlerBlockRule("GPTBot", "critical", "GPTBot feeds OpenAI's training and retrieval corpus."),
  crawlerBlockRule("OAI-SearchBot", "critical", "OAI-SearchBot is what ChatGPT search uses to index and cite pages."),
  crawlerBlockRule("ChatGPT-User", "high", "ChatGPT-User fetches pages live while answering a user."),
  crawlerBlockRule("ClaudeBot", "critical", "ClaudeBot indexes for Anthropic's models."),
  crawlerBlockRule("Claude-User", "high", "Claude-User fetches pages live while answering a user."),
  crawlerBlockRule("PerplexityBot", "high", "PerplexityBot is Perplexity's index crawler."),
  crawlerBlockRule("Perplexity-User", "high", "Perplexity-User fetches pages live while answering a user."),
  crawlerBlockRule("Google-Extended", "medium", "Google-Extended governs whether Gemini may use your content."),
  crawlerBlockRule("bingbot", "high", "Bingbot powers Bing and Microsoft Copilot; blocking it removes you from Copilot answers entirely."),
  {
    key: "crawler.blanket_block",
    evaluate(a) {
      if (!a.crawlerAccess?.blanketBlockDetected) return null;
      return rec({ ruleKey: this.key, category: "crawler_access", priority: "critical", title: "robots.txt blocks all crawlers", description: "`User-agent: *` / `Disallow: /` with no Allow rules blocks every crawler, AI and search alike.", impact: "Nothing on the site can be indexed or cited.", evidence: { robotsTxtUrl: a.crawlerAccess.robotsTxtUrl } });
    },
  },
  {
    key: "crawler.path_blocks",
    evaluate(a) {
      const pb = a.crawlerAccess?.pathBlocks ?? [];
      if (pb.length === 0) return null;
      return rec({ ruleKey: this.key, category: "crawler_access", priority: "high", title: "AI crawlers blocked on content paths", description: `Some tier-1 AI crawlers are allowed at the root but blocked on ${pb.map((p) => p.path).join(", ")}. This is usually an old \`Disallow: /blog/\` line nobody remembers adding.`, impact: "Your best content is invisible to the engines that matter most.", evidence: { pathBlocks: pb } });
    },
  },
  {
    key: "crawler.tier1_low",
    evaluate(a) {
      if (!a.crawlerAccess || a.crawlerAccess.tier1Score >= 60) return null;
      if (a.crawlerAccess.blanketBlockDetected) return null;
      return rec({ ruleKey: this.key, category: "crawler_access", priority: "high", title: "Most tier-1 AI crawlers cannot reach the site", description: `Only ${a.crawlerAccess.tier1Score}% of the crawlers behind ChatGPT, Claude and Perplexity have full access.`, impact: "Visibility is capped regardless of content quality.", evidence: { tier1Score: a.crawlerAccess.tier1Score } });
    },
  },
  {
    key: "crawler.no_robots_txt",
    evaluate(a) {
      if (!a.crawlerAccess || a.crawlerAccess.robotsTxtFound) return null;
      return rec({ ruleKey: this.key, category: "crawler_access", priority: "low", title: "No robots.txt", description: "Crawlers default to allow, but a robots.txt with a Sitemap line is how you tell them where the content is.", impact: "Slower discovery of new pages.", evidence: { status: a.crawlerAccess.robotsTxtStatus } });
    },
  },
  // --- schema ---
  {
    key: "schema.none",
    evaluate(a) {
      if (!a.schema || a.schema.schemasFound.length > 0) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "high", title: "No structured data found", description: "None of the sampled pages carry JSON-LD, microdata or RDFa.", impact: "AI systems and rich results rely on structured data to identify your organization, authors and content type." });
    },
  },
  {
    key: "schema.no_organization",
    evaluate(a) {
      if (!a.schema || a.schema.schemasFound.length === 0) return null;
      if (a.schema.scores.organizationWithSameAs > 0) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "high", title: "Missing Organization schema", description: "Add an Organization node with name, url, logo and sameAs on the homepage.", impact: "Entity recognition — engines need to know who you are before they can cite you as an authority." });
    },
  },
  {
    key: "schema.org_without_sameas",
    evaluate(a) {
      if (!a.schema || a.schema.scores.organizationWithSameAs !== 10) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "medium", title: "Organization schema lacks sameAs", description: "Link the Organization to LinkedIn, Crunchbase, Wikidata, GitHub and X profiles via sameAs.", impact: "Disambiguates your brand from similarly named entities in knowledge graphs." });
    },
  },
  {
    key: "schema.article_without_author",
    evaluate(a) {
      if (!a.schema) return null;
      const hasArticles = a.schema.schemasFound.some((s) => /Article|BlogPosting/.test(s.type));
      if (!hasArticles || a.schema.scores.articleWithAuthor >= 15) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "medium", title: "Article schema without author", description: "Some Article/BlogPosting nodes have no author property.", impact: "Authorship is a core E-E-A-T signal for citation." });
    },
  },
  {
    key: "schema.no_person",
    evaluate(a) {
      if (!a.schema) return null;
      const hasArticles = a.schema.schemasFound.some((s) => /Article|BlogPosting/.test(s.type));
      if (!hasArticles || a.schema.scores.personSchema > 0) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "medium", title: "No Person schema for authors", description: "Add Person nodes (name, jobTitle, url, sameAs) for each author and reference them from articles.", impact: "Named, verifiable authors are what separate cited sources from ignored ones." });
    },
  },
  {
    key: "schema.no_speakable",
    evaluate(a) {
      if (!a.schema || a.schema.schemasFound.length === 0 || a.schema.scores.speakableProperty > 0) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "low", title: "No speakable property", description: "Mark the answer block with `speakable` so assistants know which passage to read aloud or lift.", impact: "Minor; helps voice and summary surfaces choose the right passage." });
    },
  },
  {
    key: "schema.legacy_format",
    evaluate(a) {
      if (!a.schema || a.schema.format === "json-ld" || a.schema.format === "none") return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "low", title: "Structured data is not JSON-LD", description: `Detected ${a.schema.format}. Move to JSON-LD, which every AI system parses reliably.`, impact: "Reduces the chance structured data is ignored." });
    },
  },
  {
    key: "schema.no_breadcrumbs",
    evaluate(a) {
      if (!a.schema || a.schema.schemasFound.length === 0 || a.schema.scores.breadcrumbList > 0) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "low", title: "No BreadcrumbList schema", description: "Add BreadcrumbList to content pages.", impact: "Helps engines understand site hierarchy and topic clusters." });
    },
  },
  {
    key: "schema.validation_issues",
    evaluate(a) {
      if (!a.schema || a.schema.issues.length === 0) return null;
      const validation = a.schema.issues.filter((i) => /parse|required/i.test(i));
      if (validation.length === 0) return null;
      return rec({ ruleKey: this.key, category: "schema", priority: "medium", title: "Structured data has validation errors", description: validation.join(" "), impact: "Invalid blocks are discarded entirely by parsers.", evidence: { issues: validation } });
    },
  },
  // --- citability ---
  {
    key: "citability.low",
    evaluate(a) {
      if (!a.citability) return null;
      const s = a.citability.averageScore;
      if (s >= 70) return null;
      const priority = s < 30 ? "critical" : s < 50 ? "high" : "medium";
      return rec({ ruleKey: this.key, category: "citability", priority, title: `Passage citability is ${priority === "critical" ? "very low" : "low"} (${s}/100)`, description: "Content is not written in the direct-answer, self-contained passages AI engines lift. Lead each section with a 40–60 word answer, keep paragraphs atomic, and add attributed statistics.", impact: "Citability is the single strongest predictor of being quoted in an AI answer.", evidence: { averageScore: s } });
    },
  },
  {
    key: "citability.answer_blocks",
    evaluate(a) {
      if (!a.citability || a.citability.averageScore === 0 || a.citability.dimensions.answerBlockQuality >= 15) return null;
      return rec({ ruleKey: this.key, category: "citability", priority: "high", title: "Weak answer blocks", description: "Passages rarely open with a direct answer to a specific question.", impact: "Engines prefer passages whose first sentence is the answer.", evidence: { answerBlockQuality: a.citability.dimensions.answerBlockQuality } });
    },
  },
  {
    key: "citability.statistics",
    evaluate(a) {
      if (!a.citability || a.citability.averageScore === 0 || a.citability.dimensions.statisticalDensity >= 7) return null;
      return rec({ ruleKey: this.key, category: "citability", priority: "medium", title: "Few concrete numbers", description: "Passages lack specific figures, dates and named entities.", impact: "Specific, attributed data is what gets quoted.", evidence: { statisticalDensity: a.citability.dimensions.statisticalDensity } });
    },
  },
  {
    key: "citability.self_containment",
    evaluate(a) {
      if (!a.citability || a.citability.averageScore === 0 || a.citability.dimensions.selfContainment >= 12) return null;
      return rec({ ruleKey: this.key, category: "citability", priority: "medium", title: "Passages depend on surrounding context", description: "Sections open with back-references ('as mentioned above', 'this') and pronouns instead of restating the subject.", impact: "A passage that only makes sense in context cannot be lifted.", evidence: { selfContainment: a.citability.dimensions.selfContainment } });
    },
  },
  // --- eeat ---
  {
    key: "eeat.low",
    evaluate(a) {
      if (!a.eeat || a.eeat.totalScore >= 30) return null;
      return rec({ ruleKey: this.key, category: "eeat", priority: "critical", title: `Very weak E-E-A-T signals (${a.eeat.totalScore}/100)`, description: "The site shows little evidence of real authors, first-hand experience, or trust infrastructure.", impact: "AI engines down-weight sources they cannot attribute to a credible entity." });
    },
  },
  ...(["experience", "expertise", "authoritativeness", "trustworthiness"] as const).map(
    (d): SiteRule => ({
      key: `eeat.${d}_low`,
      evaluate(a) {
        if (!a.eeat || a.eeat.totalScore < 30 || a.eeat[d] >= 10) return null;
        const missing = a.eeat.signals.filter((s) => s.dimension === d && !s.present).map((s) => s.signal);
        return rec({ ruleKey: this.key, category: "eeat", priority: "high", title: `Low ${d} (${a.eeat[d]}/25)`, description: missing.length ? `Missing: ${missing.join("; ")}.` : `The ${d} dimension scores poorly.`, impact: `${d[0]!.toUpperCase()}${d.slice(1)} is one quarter of the E-E-A-T assessment.`, evidence: { missing } });
      },
    }),
  ),
  {
    key: "eeat.missing_high_impact",
    evaluate(a) {
      if (!a.eeat) return null;
      const missing = a.eeat.signals.filter((s) => s.impact === "high" && !s.present);
      if (missing.length < 2) return null;
      return rec({ ruleKey: this.key, category: "eeat", priority: "medium", title: `${missing.length} high-impact trust signals missing`, description: missing.map((m) => m.signal).join("; ") + ".", impact: "Each is cheap to add and individually weighed by engines.", evidence: { missing: missing.map((m) => m.signal) } });
    },
  },
  // --- technical ---
  {
    key: "technical.no_ssr",
    evaluate(a) {
      if (!a.technical || a.technical.ssrDetected) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "critical", title: "Content is not server-rendered", description: `The page ships as a ${a.technical.framework === "spa" ? "client-side app" : "near-empty shell"}; the content only exists after JavaScript runs.`, impact: "Most AI crawlers do not execute JavaScript. They see an empty page.", evidence: { framework: a.technical.framework } });
    },
  },
  {
    key: "technical.noindex",
    evaluate(a) {
      if (!a.technical || !a.technical.noindex) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "critical", title: "Homepage is marked noindex", description: "A robots meta tag or X-Robots-Tag header says noindex.", impact: "The page is excluded from every index." });
    },
  },
  {
    key: "technical.no_https",
    evaluate(a) {
      if (!a.technical || a.technical.httpsEnabled) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "critical", title: "Site is not served over HTTPS", description: "The final URL after redirects is http://.", impact: "Trust signal and a hard requirement for several crawlers." });
    },
  },
  {
    key: "technical.bad_status",
    evaluate(a) {
      if (!a.technical || (a.technical.httpStatus >= 200 && a.technical.httpStatus < 300)) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "critical", title: `Homepage returned HTTP ${a.technical.httpStatus}`, description: a.technical.httpStatus === 403 || a.technical.httpStatus === 503 ? "This is typically a WAF or bot-protection challenge. Crawlers get the same response." : "The homepage did not return a success status.", impact: "Crawlers are turned away at the door.", evidence: { status: a.technical.httpStatus } });
    },
  },
  {
    key: "technical.missing_core_meta",
    evaluate(a) {
      if (!a.technical) return null;
      const core = a.technical.metaTags.missing.filter((m) => ["title", "description"].includes(m));
      if (core.length === 0) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "high", title: `Missing ${core.join(" and ")} meta`, description: "The page has no usable title/description.", impact: "These are the first thing every engine reads.", evidence: { missing: core } });
    },
  },
  {
    key: "technical.missing_viewport",
    evaluate(a) {
      if (!a.technical || a.technical.mobileOptimized) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "high", title: "No mobile viewport", description: "Add `<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">`.", impact: "Google indexes mobile-first." });
    },
  },
  {
    key: "technical.missing_canonical",
    evaluate(a) {
      if (!a.technical || !a.technical.metaTags.missing.includes("canonical")) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "medium", title: "No canonical URL", description: "Add `<link rel=\"canonical\">` to every page.", impact: "Without it, www/non-www and parameter variants split citation credit." });
    },
  },
  {
    key: "technical.missing_og_image",
    evaluate(a) {
      if (!a.technical || !a.technical.metaTags.missing.includes("og:image")) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "low", title: "No og:image", description: "Add an Open Graph image.", impact: "Affects how links render when an answer is shared, not citation itself." });
    },
  },
  {
    key: "technical.security_headers",
    evaluate(a) {
      if (!a.technical || a.technical.securityHeaders.missing.length <= 3) return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "low", title: `${a.technical.securityHeaders.missing.length} security headers missing`, description: `Missing: ${a.technical.securityHeaders.missing.join(", ")}.`, impact: "Trust hygiene; minor for citation.", evidence: { missing: a.technical.securityHeaders.missing } });
    },
  },
  {
    key: "technical.lcp_risk",
    evaluate(a) {
      if (!a.technical) return null;
      const cwv = a.technical.coreWebVitalsIndicators;
      if (cwv.estimatedLcpRisk === "low") return null;
      return rec({ ruleKey: this.key, category: "technical", priority: cwv.estimatedLcpRisk === "high" ? "medium" : "low", title: `${cwv.estimatedLcpRisk === "high" ? "High" : "Moderate"} LCP risk`, description: [cwv.hasLargeHeroImage && "large hero image", cwv.hasRenderBlockingResources && "render-blocking resources in <head>", cwv.hasUnsizedImages && "unsized images"].filter(Boolean).join(", ") + ".", impact: "Page experience is a ranking input for the Google surfaces.", evidence: cwv });
    },
  },
  {
    key: "technical.parameterized_urls",
    evaluate(a) {
      if (!a.technical || a.technical.urlStructure !== "parameterized") return null;
      return rec({ ruleKey: this.key, category: "technical", priority: "low", title: "URLs are mostly parameterized", description: "Most discovered internal links carry query strings.", impact: "Clean paths are easier to cite and dedupe." });
    },
  },
  // --- llms.txt ---
  {
    key: "llms_txt.missing",
    evaluate(a) {
      if (!a.llmsTxt || a.llmsTxt.found) return null;
      return rec({ ruleKey: this.key, category: "llms_txt", priority: "medium", title: "No llms.txt", description: "Publish /llms.txt: a title, a one-paragraph description, and sections of links to your most important pages.", impact: "An emerging convention that tells models where your canonical content lives." });
    },
  },
  {
    key: "llms_txt.invalid",
    evaluate(a) {
      if (!a.llmsTxt || !a.llmsTxt.found || a.llmsTxt.valid) return null;
      return rec({ ruleKey: this.key, category: "llms_txt", priority: "low", title: "llms.txt has issues", description: a.llmsTxt.issues.join(" "), impact: "A malformed file may be ignored.", evidence: { issues: a.llmsTxt.issues } });
    },
  },
  {
    key: "llms_txt.thin",
    evaluate(a) {
      if (!a.llmsTxt || !a.llmsTxt.found || !a.llmsTxt.valid || a.llmsTxt.sections.length >= 3) return null;
      return rec({ ruleKey: this.key, category: "llms_txt", priority: "low", title: "llms.txt is thin", description: `Only ${a.llmsTxt.sections.length} section(s). Add Docs, Product, Blog and Company sections.`, impact: "More coverage, more surface for models to navigate." });
    },
  },
  // --- platform (presentational) ---
  {
    key: "platform.broad_weakness",
    evaluate(a) {
      if (!a.platformReadiness) return null;
      const weak = Object.entries(a.platformReadiness.platforms).filter(([, p]) => p.score < 40);
      if (weak.length < 3) return null;
      return rec({ ruleKey: this.key, category: "platform", priority: "medium", title: `Weak readiness on ${weak.length} of 5 AI platforms`, description: weak.map(([k, p]) => `${k}: ${p.weaknesses[0] ?? "low score"}`).join("; ") + ".", impact: "Presentational summary of the dimensions above; fix those first.", evidence: { weak: weak.map(([k, p]) => ({ platform: k, score: p.score })) } });
    },
  },
];

const PRIORITY_ORDER: Record<SiteRecommendation["priority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function runSiteRules(a: SiteRuleInput, rules: SiteRule[] = SITE_RULES): SiteRecommendation[] {
  const out: SiteRecommendation[] = [];
  for (const r of rules) {
    try {
      const f = r.evaluate(a);
      if (f) out.push(f);
    } catch {
      /* a broken rule must not break the audit */
    }
  }
  return out.sort((x, y) => PRIORITY_ORDER[x.priority] - PRIORITY_ORDER[y.priority]);
}
