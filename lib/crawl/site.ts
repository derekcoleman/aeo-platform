import { htmlToMarkdown, internalLinks, pageTitle, parseHtml, sitemapLocs, ASSET_RE } from "@/lib/audit/html";
import { mapConcurrent, safeFetch, type FetchOptions, type FetchResult } from "@/lib/fetch/fetch";
import { checkSsrf } from "@/lib/fetch/ssrf";

/**
 * A small, polite crawl of a customer's own website for the brand brain and
 * the business profile. Not the audit's sample (which optimises for scoring
 * variety) and not a full-site spider: it wants the pages that say what the
 * company is — home, about, pricing, products, solutions, customers,
 * integrations, docs index, comparisons, FAQ — and a few more by depth.
 *
 * Every fetch goes through safeFetch (SSRF-checked, size-capped, redirects
 * checked hop by hop). Pages are returned as markdown so they slot straight
 * into context.context_documents.
 */

export type PageKind = "home" | "about" | "pricing" | "product" | "solutions" | "customers" | "integrations" | "docs" | "compare" | "faq" | "blog" | "legal" | "other";

const KIND_RULES: [PageKind, RegExp][] = [
  ["about", /^\/(about|company|team|our-story|who-we-are|mission)(\/|$)/i],
  ["pricing", /^\/(pricing|plans|packages)(\/|$)/i],
  ["product", /^\/(products?|features?|platform|how-it-works)(\/|$)/i],
  ["solutions", /^\/(solutions?|use-cases?|industries|for)(\/|$)/i],
  ["customers", /^\/(customers?|case-stud(y|ies)|success-stories|testimonials|reviews)(\/|$)/i],
  ["integrations", /^\/(integrations?|partners?|marketplace|apps)(\/|$)/i],
  ["compare", /^\/(compare|vs|versus|alternatives?)(\/|$)/i],
  ["faq", /^\/(faq|faqs|help|support)(\/|$)/i],
  ["docs", /^\/(docs?|documentation|developers?|api)(\/|$)/i],
  ["blog", /^\/(blog|resources|articles|guides|insights|news)(\/|$)/i],
  ["legal", /^\/(privacy|terms|legal|cookies?|security|gdpr|dpa)(\/|$)/i],
  // A comparison page outside a named section (/okta-vs-entra, /jira-alternative): after the section rules so /blog/x-vs-y stays a blog post.
  ["compare", /(-vs-|-versus-)|(-alternatives?)(\/|$)/i],
];

/** How much a kind tells us about the business; drives page selection order. */
const KIND_WEIGHT: Record<PageKind, number> = {
  home: 100, about: 90, pricing: 85, product: 80, solutions: 70, customers: 60, integrations: 55, compare: 50, faq: 45, docs: 30, blog: 20, other: 15, legal: 0,
};

export function classifyPath(path: string): PageKind {
  if (path === "/" || path === "") return "home";
  for (const [kind, re] of KIND_RULES) if (re.test(path)) return kind;
  return "other";
}

export interface CrawledPage {
  url: string;
  path: string;
  kind: PageKind;
  title: string;
  markdown: string;
  status: number;
}

/** Order candidate URLs by how much they say about the business; shallow before deep, no assets, no fragments. */
export function prioritizeForProfile(urls: string[], max: number, origin?: string): string[] {
  const seen = new Set<string>();
  const scored: { url: string; score: number }[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (origin && u.origin !== origin) continue;
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (ASSET_RE.test(u.pathname)) continue;
    u.hash = "";
    u.search = "";
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = classifyPath(u.pathname);
    if (kind === "legal") continue;
    const depth = u.pathname.split("/").filter(Boolean).length;
    scored.push({ url: key, score: KIND_WEIGHT[kind] - depth * 4 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.url);
}

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  pageMaxChars?: number;
  fetch?: Pick<FetchOptions, "timeoutMs" | "maxBytes" | "allowPrivate" | "fetchImpl" | "userAgent">;
}

export class CrawlError extends Error {
  constructor(message: string, public readonly code: "blocked" | "unreachable" | "not_html") {
    super(message);
    this.name = "CrawlError";
  }
}

function isHtml(r: FetchResult): boolean {
  return /text\/html|application\/xhtml/i.test(r.contentType ?? "") || /<html/i.test(r.body.slice(0, 2000));
}

async function robotsSitemaps(origin: string, fetchOpts: CrawlOptions["fetch"]): Promise<string[]> {
  try {
    const r = await safeFetch(`${origin}/robots.txt`, { ...fetchOpts, maxRetries: 0 });
    if (!r.ok) return [];
    return [...r.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  } catch {
    return [];
  }
}

async function sitemapUrls(origin: string, seeds: string[], fetchOpts: CrawlOptions["fetch"], budget: number): Promise<string[]> {
  const queue = [...seeds, `${origin}/sitemap.xml`];
  const visited = new Set<string>();
  const out: string[] = [];
  while (queue.length && visited.size < 4 && out.length < budget) {
    const sm = queue.shift()!;
    if (visited.has(sm) || !checkSsrf(sm).safe) continue;
    visited.add(sm);
    try {
      const r = await safeFetch(sm, { ...fetchOpts, maxRetries: 0 });
      if (!r.ok) continue;
      const { urls, children } = sitemapLocs(r.body);
      out.push(...urls);
      queue.push(...children.slice(0, 2));
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Crawl `origin` (scheme + host) and return the most business-relevant pages as markdown. */
export async function crawlSite(origin: string, options: CrawlOptions = {}): Promise<{ origin: string; pages: CrawledPage[] }> {
  const maxPages = options.maxPages ?? 20;
  const concurrency = options.concurrency ?? 4;
  const pageMaxChars = options.pageMaxChars ?? 20_000;
  const target = new URL(origin);
  const ssrf = checkSsrf(target.href);
  if (!ssrf.safe) throw new CrawlError(ssrf.reason ?? "blocked", "blocked");

  let home: FetchResult;
  try {
    home = await safeFetch(target.href, options.fetch);
  } catch (e) {
    throw new CrawlError(`Could not fetch ${target.href}: ${(e as Error).message}`, "unreachable");
  }
  if (!home.ok) throw new CrawlError(`${home.finalUrl} answered ${home.status}`, "unreachable");
  if (!isHtml(home)) throw new CrawlError(`${home.finalUrl} did not return HTML`, "not_html");
  const finalOrigin = new URL(home.finalUrl).origin;
  const home$ = parseHtml(home.body);

  const linked = internalLinks(home$, home.finalUrl);
  const fromSitemap = linked.length >= maxPages * 2 ? [] : await sitemapUrls(finalOrigin, await robotsSitemaps(finalOrigin, options.fetch), options.fetch, maxPages * 5);
  const candidates = prioritizeForProfile([...linked, ...fromSitemap].filter((u) => u.replace(/\/$/, "") !== home.finalUrl.replace(/\/$/, "")), maxPages - 1, finalOrigin);

  const fetched = await mapConcurrent(candidates, concurrency, async (url) => {
    try {
      const r = await safeFetch(url, { ...options.fetch, maxRetries: 0 });
      return r.ok && isHtml(r) ? r : null;
    } catch {
      return null;
    }
  });

  const toPage = (r: FetchResult): CrawledPage => {
    const $ = parseHtml(r.body);
    const path = new URL(r.finalUrl).pathname || "/";
    return { url: r.finalUrl, path, kind: classifyPath(path), title: pageTitle($), markdown: htmlToMarkdown(r.body, pageMaxChars), status: r.status };
  };
  const pages = [toPage(home)];
  const seen = new Set([home.finalUrl]);
  for (const r of fetched) {
    if (!r || seen.has(r.finalUrl)) continue;
    seen.add(r.finalUrl);
    const p = toPage(r);
    if (p.markdown.trim().length < 80) continue;
    pages.push(p);
  }
  return { origin: finalOrigin, pages };
}
