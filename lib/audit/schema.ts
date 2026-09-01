import type { Doc } from "./html";
import type { SchemaAnalysisResult, SchemaFormat, SchemaItem, SchemaScores } from "./types";

/**
 * Structured-data extraction and scoring.
 *
 * gtm-agents extracted deterministically and then asked an LLM to score ten
 * criteria it could have computed. Every criterion here is computed; the
 * "validation" sub-score checks required properties against a small
 * vocabulary table instead of asking a model to guess.
 */

type Json = Record<string, unknown>;

export interface ExtractedSchema {
  items: SchemaItem[];
  malformedBlocks: number;
  hasMicrodata: boolean;
  hasRdfa: boolean;
  /** Raw parsed JSON-LD nodes, for validation. */
  nodes: { node: Json; sourceUrl: string }[];
}

const KNOWN_SAMEAS_HOSTS = ["linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com", "github.com", "wikipedia.org", "wikidata.org", "crunchbase.com", "instagram.com", "g2.com"];

/** Required properties per type, per schema.org + Google rich-result guidance. */
const REQUIRED: Record<string, string[]> = {
  Organization: ["name", "url"],
  Corporation: ["name", "url"],
  LocalBusiness: ["name", "address"],
  Person: ["name"],
  Article: ["headline", "author", "datePublished"],
  BlogPosting: ["headline", "author", "datePublished"],
  NewsArticle: ["headline", "author", "datePublished"],
  TechArticle: ["headline", "author", "datePublished"],
  WebSite: ["name", "url"],
  WebPage: ["name"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
  HowTo: ["name", "step"],
  Product: ["name"],
  SoftwareApplication: ["name", "applicationCategory"],
  Event: ["name", "startDate", "location"],
  VideoObject: ["name", "thumbnailUrl", "uploadDate"],
};

const DEPRECATED_TYPES = new Set(["Blog", "UserComments", "UserInteraction", "UserLikes", "UserPlusOnes"]);

function typesOf(node: Json): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function flatten(node: unknown, out: Json[]): void {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Json;
  if (Array.isArray(obj["@graph"])) {
    for (const n of obj["@graph"]) flatten(n, out);
    if (!obj["@type"]) return;
  }
  out.push(obj);
  // Nested typed nodes (author: {@type: Person}) count too.
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("@")) continue;
    if (v && typeof v === "object") {
      const nested: Json[] = [];
      flatten(v, nested);
      for (const n of nested) if (n["@type"]) out.push(n);
    }
  }
}

export function extractSchemas($: Doc, sourceUrl: string): ExtractedSchema {
  const items: SchemaItem[] = [];
  const nodes: ExtractedSchema["nodes"] = [];
  let malformedBlocks = 0;

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformedBlocks++;
      return;
    }
    const flat: Json[] = [];
    flatten(parsed, flat);
    const seen = new Set<Json>();
    for (const node of flat) {
      if (seen.has(node)) continue;
      seen.add(node);
      const types = typesOf(node);
      if (types.length === 0) continue;
      nodes.push({ node, sourceUrl });
      const sameAs = node.sameAs;
      const sameAsUrls = Array.isArray(sameAs) ? sameAs.filter((s): s is string => typeof s === "string") : typeof sameAs === "string" ? [sameAs] : [];
      for (const type of types) {
        items.push({
          type,
          format: "json-ld",
          properties: Object.keys(node).filter((k) => !k.startsWith("@")),
          hasSameAs: sameAsUrls.length > 0,
          sameAsUrls: sameAsUrls.length > 0 ? sameAsUrls : undefined,
          sourceUrl,
        });
      }
    }
  });

  const hasMicrodata = $("[itemscope]").length > 0 && $("[itemprop]").length > 0;
  if (hasMicrodata) {
    $("[itemscope][itemtype]").each((_, el) => {
      const t = ($(el).attr("itemtype") ?? "").split("/").pop() ?? "";
      if (!t) return;
      const props = $(el).find("[itemprop]").toArray().map((p) => $(p).attr("itemprop") ?? "").filter(Boolean);
      items.push({ type: t, format: "microdata", properties: Array.from(new Set(props)), hasSameAs: props.includes("sameAs"), sourceUrl });
    });
  }
  const hasRdfa = $("[typeof]").length > 0 && $("[property]").length > 0;
  if (hasRdfa) {
    $("[typeof]").each((_, el) => {
      const t = ($(el).attr("typeof") ?? "").split(/[\s/:]/).pop() ?? "";
      if (!t) return;
      const props = $(el).find("[property]").toArray().map((p) => $(p).attr("property") ?? "").filter(Boolean);
      items.push({ type: t, format: "rdfa", properties: Array.from(new Set(props)), hasSameAs: props.includes("sameAs"), sourceUrl });
    });
  }

  return { items, malformedBlocks, hasMicrodata, hasRdfa, nodes };
}

export function determineFormat(ex: ExtractedSchema): SchemaFormat {
  const formats = new Set(ex.items.map((i) => i.format));
  if (formats.size === 0) return "none";
  if (formats.size > 1) return "mixed";
  return [...formats][0]!;
}

function has(items: SchemaItem[], type: string | RegExp): SchemaItem[] {
  return items.filter((i) => (typeof type === "string" ? i.type === type : type.test(i.type)));
}

const ARTICLE_RE = /^(Article|BlogPosting|NewsArticle|TechArticle|ScholarlyArticle|Report)$/;
const ORG_RE = /^(Organization|Corporation|LocalBusiness|NGO|EducationalOrganization|GovernmentOrganization)$/;

/** Pure scoring over the merged extraction from every sampled page. */
export function scoreSchemas(ex: ExtractedSchema): { scores: SchemaScores; issues: string[] } {
  const items = ex.items;
  const issues: string[] = [];

  const orgs = has(items, ORG_RE);
  const orgWithSameAs = orgs.filter((o) => o.hasSameAs);
  const organizationWithSameAs = orgs.length === 0 ? 0 : orgWithSameAs.length > 0 ? 20 : 10;
  if (orgs.length === 0) issues.push("No Organization schema found on any sampled page");
  else if (orgWithSameAs.length === 0) issues.push("Organization schema has no sameAs links to authoritative profiles");

  const articles = has(items, ARTICLE_RE);
  const articlesWithAuthor = articles.filter((a) => a.properties.includes("author"));
  const articleWithAuthor = articles.length === 0 ? 0 : Math.round((articlesWithAuthor.length / articles.length) * 15);
  if (articles.length > 0 && articlesWithAuthor.length < articles.length) {
    issues.push(`${articles.length - articlesWithAuthor.length} of ${articles.length} Article schemas lack an author`);
  }

  const persons = has(items, "Person");
  const personSchema = persons.length === 0 ? 0 : persons.some((p) => p.hasSameAs || p.properties.includes("jobTitle") || p.properties.includes("url")) ? 15 : 8;
  if (persons.length === 0 && articles.length > 0) issues.push("Articles exist but no Person schema identifies the authors");

  const allSameAs = items.flatMap((i) => i.sameAsUrls ?? []);
  const hosts = new Set(allSameAs.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean));
  const authoritative = [...hosts].filter((h) => KNOWN_SAMEAS_HOSTS.some((k) => h.endsWith(k))).length;
  const sameAsCompleteness = Math.min(15, authoritative * 4 + (allSameAs.length > 0 ? 3 : 0));

  const speakable = items.some((i) => i.properties.includes("speakable"));
  const speakableProperty = speakable ? 10 : 0;

  const breadcrumbList = has(items, "BreadcrumbList").length > 0 ? 5 : 0;
  const website = has(items, "WebSite");
  const websiteSearchAction = website.some((w) => w.properties.includes("potentialAction")) ? 5 : website.length > 0 ? 2 : 0;

  const deprecated = items.filter((i) => DEPRECATED_TYPES.has(i.type));
  // Only a credit when there is schema to be deprecated; an empty page scores 0 across the board.
  const noDeprecated = items.length > 0 && deprecated.length === 0 ? 5 : 0;
  if (deprecated.length > 0) issues.push(`Deprecated schema types in use: ${[...new Set(deprecated.map((d) => d.type))].join(", ")}`);

  const jsonLd = items.filter((i) => i.format === "json-ld").length;
  const jsonLdFormat = items.length === 0 ? 0 : jsonLd === items.length ? 5 : jsonLd > 0 ? 3 : 0;
  if (items.length > 0 && jsonLd === 0) issues.push("Structured data is microdata/RDFa only — JSON-LD is what AI systems parse most reliably");

  let validation = 5;
  if (ex.malformedBlocks > 0) {
    validation -= 3;
    issues.push(`${ex.malformedBlocks} JSON-LD block(s) failed to parse`);
  }
  const missingRequired: string[] = [];
  for (const { node } of ex.nodes) {
    for (const t of typesOf(node)) {
      const req = REQUIRED[t];
      if (!req) continue;
      for (const p of req) if (!(p in node)) missingRequired.push(`${t}.${p}`);
    }
  }
  if (missingRequired.length > 0) {
    validation -= Math.min(2, missingRequired.length);
    issues.push(`Missing required properties: ${[...new Set(missingRequired)].slice(0, 6).join(", ")}`);
  }
  if (ex.nodes.length === 0 && items.length === 0) validation = 0;

  return {
    scores: {
      organizationWithSameAs,
      articleWithAuthor,
      personSchema,
      sameAsCompleteness,
      speakableProperty,
      breadcrumbList,
      websiteSearchAction,
      noDeprecated,
      jsonLdFormat,
      validation: Math.max(0, validation),
    },
    issues,
  };
}

export function mergeExtractions(list: ExtractedSchema[]): ExtractedSchema {
  return {
    items: list.flatMap((e) => e.items),
    malformedBlocks: list.reduce((n, e) => n + e.malformedBlocks, 0),
    hasMicrodata: list.some((e) => e.hasMicrodata),
    hasRdfa: list.some((e) => e.hasRdfa),
    nodes: list.flatMap((e) => e.nodes),
  };
}

export function analyzeSchema(extractions: ExtractedSchema[]): SchemaAnalysisResult {
  const merged = mergeExtractions(extractions);
  const { scores, issues } = scoreSchemas(merged);
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    format: determineFormat(merged),
    schemasFound: merged.items,
    malformedBlocks: merged.malformedBlocks,
    scores,
    totalScore: Math.max(0, Math.min(100, totalScore)),
    issues,
  };
}
