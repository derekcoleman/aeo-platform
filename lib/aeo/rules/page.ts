import { extractSchemas } from "@/lib/audit/schema";
import type { PageInput, PageRule, RuleFinding } from "./types";

/**
 * Page-level structural rules. Deterministic, DOM-driven, no model calls.
 * Each rule returns a score in [0, maxScore] plus the evidence that produced
 * it, so a linter failure and an audit finding read identically.
 */

const QUESTION_RE = /\?\s*$|^(how|what|why|when|where|which|who|can|should|is|are|does|do|will|did)\b/i;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

interface Section {
  heading: string;
  level: number;
  paragraphs: string[];
}

/** Split the main content into heading-delimited sections. */
export function sections(page: PageInput): { h1: string | null; sections: Section[]; lead: string[] } {
  const $ = page.$;
  const root = $("main, article").first().length ? $("main, article").first() : $("body");
  const h1 = root.find("h1").first().text().trim() || $("h1").first().text().trim() || null;
  const out: Section[] = [];
  const lead: string[] = [];
  let current: Section | null = null;
  let seenH1 = false;
  root.find("h1, h2, h3, h4, p, li, td").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (tag === "h1") {
      seenH1 = true;
      return;
    }
    if (tag === "h2" || tag === "h3" || tag === "h4") {
      current = { heading: text, level: Number(tag[1]), paragraphs: [] };
      out.push(current);
      return;
    }
    if (tag === "li" || tag === "td") return; // counted via parents, not as paragraphs
    if (current) current.paragraphs.push(text);
    else if (seenH1 || out.length === 0) lead.push(text);
  });
  return { h1, sections: out, lead };
}

function finding(rule: PageRule, score: number, passed: boolean, evidence: Record<string, unknown>, recommendation?: string, notApplicable = false): RuleFinding {
  return { key: rule.key, title: rule.title, passed, score: Math.max(0, Math.min(rule.maxScore, Math.round(score))), maxScore: rule.maxScore, evidence, recommendation, notApplicable };
}

export const answerBlock: PageRule = {
  key: "answer_block",
  title: "Direct answer under the title and each question heading",
  description: "The first paragraph after the H1, and after every question-form H2, is a self-contained answer of at most 60 words.",
  maxScore: 15,
  evaluate(page) {
    const { sections: secs, lead } = sections(page);
    const targets: { where: string; first: string | undefined }[] = [{ where: "h1", first: lead[0] }];
    for (const s of secs) if (s.level === 2 && QUESTION_RE.test(s.heading)) targets.push({ where: s.heading, first: s.paragraphs[0] });
    const ok = targets.filter((t) => t.first && words(t.first) <= 60 && words(t.first) >= 15);
    const ratio = targets.length === 0 ? 0 : ok.length / targets.length;
    return finding(this, ratio * this.maxScore, ratio >= 0.8, {
      checked: targets.length,
      passing: ok.length,
      failing: targets.filter((t) => !ok.includes(t)).map((t) => ({ where: t.where, words: t.first ? words(t.first) : 0 })).slice(0, 5),
    }, ratio < 0.8 ? "Open the page and each question section with a 40–60 word answer that stands alone." : undefined);
  },
};

export const questionHeadings: PageRule = {
  key: "question_headings",
  title: "Headings are the questions buyers ask",
  description: "At least 60% of H2s are phrased as questions.",
  maxScore: 10,
  evaluate(page) {
    const h2 = sections(page).sections.filter((s) => s.level === 2).map((s) => s.heading);
    const q = h2.filter((h) => QUESTION_RE.test(h));
    const ratio = h2.length === 0 ? 0 : q.length / h2.length;
    return finding(this, Math.min(1, ratio / 0.6) * this.maxScore, ratio >= 0.6, { h2Count: h2.length, questionCount: q.length, sample: h2.slice(0, 6) },
      ratio < 0.6 ? "Rewrite H2s as the literal question the section answers." : undefined, h2.length === 0);
  },
};

export const paragraphAtomicity: PageRule = {
  key: "paragraph_atomicity",
  title: "Paragraphs are short and single-idea",
  description: "At least 80% of paragraphs are under 100 words; median under 70.",
  maxScore: 8,
  evaluate(page) {
    const { sections: secs, lead } = sections(page);
    const paras = [...lead, ...secs.flatMap((s) => s.paragraphs)].filter((p) => words(p) >= 5);
    if (paras.length === 0) return finding(this, 0, false, { paragraphs: 0 }, "No paragraph content found.");
    const lengths = paras.map(words).sort((a, b) => a - b);
    const under100 = lengths.filter((n) => n < 100).length / lengths.length;
    const median = lengths[Math.floor(lengths.length / 2)]!;
    const score = (Math.min(1, under100 / 0.8) * 0.6 + (median <= 70 ? 0.4 : Math.max(0, 0.4 - (median - 70) / 100))) * this.maxScore;
    return finding(this, score, under100 >= 0.8 && median <= 70, { paragraphs: paras.length, under100: Math.round(under100 * 100), medianWords: median },
      under100 < 0.8 ? "Split long paragraphs; answer engines quote a paragraph, not a page." : undefined);
  },
};

const STAT_RE = /(\d+(\.\d+)?\s?%|\$\s?\d[\d,.]*\s?(k|m|b|million|billion)?|\b\d{1,3}(,\d{3})+\b|\b\d+(\.\d+)?x\b|\b(19|20)\d{2}\b)/i;
const ATTRIBUTION_RE = /(according to|per |source:|reported|survey|study|research|data from|found that|\(\d{4}\))/i;

export const attributedStats: PageRule = {
  key: "attributed_stats",
  title: "Statistics are attributed",
  description: "Sentences that state a number also name a source or link out.",
  maxScore: 10,
  evaluate(page) {
    const $ = page.$;
    const root = $("main, article").first().length ? $("main, article").first() : $("body");
    let stats = 0;
    let attributed = 0;
    root.find("p, li").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if (!STAT_RE.test(sentence)) continue;
        stats++;
        if (ATTRIBUTION_RE.test(sentence) || $(el).find("a[href^='http']").length > 0) attributed++;
      }
    });
    if (stats === 0) return finding(this, this.maxScore * 0.4, false, { statistics: 0 }, "Add specific, sourced numbers — passages with attributed statistics are cited disproportionately.");
    const ratio = attributed / stats;
    return finding(this, (0.5 + ratio * 0.5) * this.maxScore, ratio >= 0.7, { statistics: stats, attributed, ratio: Math.round(ratio * 100) },
      ratio < 0.7 ? "Attribute every statistic to a named source with a link." : undefined);
  },
};

export const definitions: PageRule = {
  key: "definitions",
  title: "Key term is defined up front",
  description: "A definitional sentence ('X is a …') appears in the first 300 words.",
  maxScore: 5,
  evaluate(page) {
    const { h1, lead, sections: secs } = sections(page);
    const opening = [...lead, ...secs.slice(0, 1).flatMap((s) => s.paragraphs)].join(" ").split(/\s+/).slice(0, 300).join(" ");
    const subject = (h1 ?? "").replace(/[?:].*$/, "").trim();
    const defRe = /\b([A-Z][\w-]+(?:\s+[\w-]+){0,4})\s+(is|are|refers to|means)\s+(a|an|the)\b/;
    const m = opening.match(defRe);
    const usesSubject = !!m && !!subject && subject.toLowerCase().includes(m[1]!.toLowerCase().split(" ")[0]!);
    const score = m ? (usesSubject ? this.maxScore : this.maxScore * 0.6) : 0;
    return finding(this, score, !!m, { definition: m?.[0] ?? null, subject }, m ? undefined : "Define the page's subject in one sentence within the first paragraph.");
  },
};

const COMPARATIVE_RE = /\b(vs\.?|versus|compared?|comparison|alternatives?|best|top \d+|pricing)\b/i;

export const comparisonTable: PageRule = {
  key: "comparison_table",
  title: "Comparative pages carry a table",
  description: "When intent is comparative, a table with at least 2 columns and 3 rows exists.",
  maxScore: 8,
  evaluate(page) {
    const h1 = sections(page).h1 ?? "";
    const comparative = page.intent === "comparative" || (page.intent === undefined && COMPARATIVE_RE.test(h1));
    const tables = page.$("table").toArray().filter((t) => page.$(t).find("tr").length >= 3 && page.$(t).find("tr").first().find("th, td").length >= 2);
    if (!comparative) return finding(this, tables.length > 0 ? this.maxScore : 0, true, { comparative: false, tables: tables.length }, undefined, tables.length === 0);
    return finding(this, tables.length > 0 ? this.maxScore : 0, tables.length > 0, { comparative: true, tables: tables.length },
      tables.length === 0 ? "Add a comparison table — tables are lifted into AI answers far more often than prose." : undefined);
  },
};

export const faqBlock: PageRule = {
  key: "faq_block",
  title: "FAQ block present",
  description: "An FAQ section (heading or FAQPage schema) with at least 3 question/answer pairs.",
  maxScore: 6,
  evaluate(page) {
    const $ = page.$;
    const faqHeading = $("h2, h3").toArray().find((el) => /\bfaq|frequently asked|common questions\b/i.test($(el).text()));
    const schema = extractSchemas($, page.url).nodes.find((n) => (n.node["@type"] === "FAQPage"));
    const mainEntity = schema ? (schema.node.mainEntity as unknown[] | undefined) : undefined;
    const qCount = Array.isArray(mainEntity) ? mainEntity.length : faqHeading ? $(faqHeading).nextAll("h3, dt, details, h4").filter((_, el) => /\?/.test($(el).text())).length : 0;
    const passed = qCount >= 3;
    return finding(this, passed ? this.maxScore : qCount > 0 ? this.maxScore / 2 : 0, passed, { faqHeading: !!faqHeading, faqSchema: !!schema, questions: qCount },
      passed ? undefined : "Add an FAQ section of 3–6 real buyer questions with 40–60 word answers, marked up as FAQPage.");
  },
};

export const schemaValid: PageRule = {
  key: "schema_valid",
  title: "Article structured data is valid",
  description: "JSON-LD parses and includes an Article/BlogPosting with headline, author, and datePublished.",
  maxScore: 10,
  evaluate(page) {
    const ex = extractSchemas(page.$, page.url);
    const article = ex.nodes.find((n) => /^(Article|BlogPosting|NewsArticle|TechArticle)$/.test(String(n.node["@type"])));
    const missing = article ? ["headline", "author", "datePublished"].filter((p) => !(p in article.node)) : ["headline", "author", "datePublished"];
    let score = 0;
    if (ex.malformedBlocks === 0 && ex.nodes.length > 0) score += 3;
    if (article) score += 3;
    score += Math.round(((3 - missing.length) / 3) * 4);
    const passed = ex.malformedBlocks === 0 && !!article && missing.length === 0;
    return finding(this, score, passed, { jsonLdBlocks: ex.nodes.length, malformed: ex.malformedBlocks, articleType: article ? String(article.node["@type"]) : null, missing },
      passed ? undefined : "Emit a BlogPosting JSON-LD block with headline, author (Person), datePublished and dateModified.");
  },
};

export const freshness: PageRule = {
  key: "freshness",
  title: "Content is dated and recent",
  description: "A machine-readable published/modified date exists and is within 12 months.",
  maxScore: 6,
  evaluate(page) {
    const $ = page.$;
    const candidates = [
      $('meta[property="article:modified_time"]').attr("content"),
      $('meta[property="article:published_time"]').attr("content"),
      $("time[datetime]").first().attr("datetime"),
    ].filter((s): s is string => !!s);
    const ex = extractSchemas($, page.url);
    for (const { node } of ex.nodes) {
      for (const k of ["dateModified", "datePublished"]) if (typeof node[k] === "string") candidates.push(node[k] as string);
    }
    const dates = candidates.map((c) => Date.parse(c)).filter((n) => Number.isFinite(n));
    if (dates.length === 0) return finding(this, 0, false, { dated: false }, "Add datePublished/dateModified in JSON-LD and a visible <time datetime> element.");
    const newest = Math.max(...dates);
    const ageDays = Math.round(((page.now ?? new Date()).getTime() - newest) / 86_400_000);
    const score = ageDays <= 365 ? this.maxScore : ageDays <= 730 ? this.maxScore / 2 : 2;
    return finding(this, score, ageDays <= 365, { dated: true, newest: new Date(newest).toISOString().slice(0, 10), ageDays },
      ageDays > 365 ? "Refresh the page and bump dateModified; answer engines prefer recent sources." : undefined);
  },
};

export const authorEeat: PageRule = {
  key: "author_eeat",
  title: "Named author with credentials",
  description: "A visible byline plus a Person schema (or author profile link) for the author.",
  maxScore: 8,
  evaluate(page) {
    const $ = page.$;
    const byline = $('[class*="author" i], [rel="author"], [itemprop="author"], .byline').first().text().replace(/\s+/g, " ").trim();
    const ex = extractSchemas($, page.url);
    const person = ex.items.some((i) => i.type === "Person");
    const profile = $('a[href*="/author/"], a[href*="/authors/"], a[href*="/team/"], a[rel="author"]').length > 0;
    const generic = /^(admin|editor|staff|team|marketing)$/i.test(byline);
    let score = 0;
    if (byline && !generic) score += 4;
    if (person) score += 2;
    if (profile) score += 2;
    const passed = !!byline && !generic && (person || profile);
    return finding(this, score, passed, { byline: byline || null, generic, personSchema: person, profileLink: profile },
      passed ? undefined : "Attribute the page to a real named author with a bio page and Person schema.");
  },
};

const CONTEXT_DEPENDENT_RE = /^(this|that|these|those|it|they|he|she|as (mentioned|noted|discussed|shown) (above|earlier|previously)|in the (previous|last) section|here)\b/i;

export const chunkExtractability: PageRule = {
  key: "chunk_extractability",
  title: "Each section stands alone",
  description: "Every H2 section is 50–400 words and does not open with a back-reference.",
  maxScore: 10,
  evaluate(page) {
    const secs = sections(page).sections.filter((s) => s.level === 2);
    if (secs.length === 0) return finding(this, 0, false, { sections: 0 }, "Break the content into H2 sections that each answer one question.", true);
    const results = secs.map((s) => {
      const w = s.paragraphs.reduce((n, p) => n + words(p), 0);
      const opener = s.paragraphs[0] ?? "";
      return { heading: s.heading, words: w, backReference: CONTEXT_DEPENDENT_RE.test(opener), ok: w >= 50 && w <= 400 && !CONTEXT_DEPENDENT_RE.test(opener) };
    });
    const ratio = results.filter((r) => r.ok).length / results.length;
    return finding(this, ratio * this.maxScore, ratio >= 0.8, { sections: secs.length, passing: results.filter((r) => r.ok).length, failing: results.filter((r) => !r.ok).slice(0, 5) },
      ratio < 0.8 ? "Make each section self-contained: restate the subject, avoid 'as mentioned above', keep 50–400 words." : undefined);
  },
};

export const headingHierarchy: PageRule = {
  key: "heading_hierarchy",
  title: "One H1, no skipped heading levels",
  description: "Exactly one H1; H2→H3→H4 without gaps.",
  maxScore: 4,
  evaluate(page) {
    const $ = page.$;
    const h1s = $("h1").length;
    const levels = $("h1, h2, h3, h4, h5, h6").toArray().map((el) => Number(el.tagName[1]));
    let skips = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i]! > levels[i - 1]! + 1) skips++;
    const passed = h1s === 1 && skips === 0;
    return finding(this, (h1s === 1 ? 2 : 0) + (skips === 0 ? 2 : skips === 1 ? 1 : 0), passed, { h1Count: h1s, skippedLevels: skips },
      passed ? undefined : h1s !== 1 ? `Use exactly one H1 (found ${h1s}).` : "Do not skip heading levels.");
  },
};

export const PAGE_RULES: PageRule[] = [
  answerBlock,
  questionHeadings,
  paragraphAtomicity,
  attributedStats,
  definitions,
  comparisonTable,
  faqBlock,
  schemaValid,
  freshness,
  authorEeat,
  chunkExtractability,
  headingHierarchy,
];

export interface StructureScore {
  score: number;
  maxScore: number;
  /** Normalized 0–100 over applicable rules. */
  normalized: number;
  findings: RuleFinding[];
}

export function runPageRules(page: PageInput, rules: PageRule[] = PAGE_RULES): StructureScore {
  const findings = rules.map((r) => {
    try {
      return r.evaluate(page);
    } catch (e) {
      return { key: r.key, title: r.title, passed: false, score: 0, maxScore: r.maxScore, evidence: { error: (e as Error).message } } satisfies RuleFinding;
    }
  });
  const applicable = findings.filter((f) => !f.notApplicable);
  const score = applicable.reduce((n, f) => n + f.score, 0);
  const maxScore = applicable.reduce((n, f) => n + f.maxScore, 0);
  return { score, maxScore, normalized: maxScore === 0 ? 0 : Math.round((score / maxScore) * 100), findings };
}
