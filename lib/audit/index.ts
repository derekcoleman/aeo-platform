import { RULE_REGISTRY_VERSION, runPageRules, runSiteRules, type StructureScore } from "@/lib/aeo/rules";
import { defaultModel, type TextModel } from "@/lib/ai/model";
import { mapConcurrent, safeFetch, type FetchOptions, type FetchResult } from "@/lib/fetch/fetch";
import { checkSsrf } from "@/lib/fetch/ssrf";
import { scoreCitability } from "./citability";
import { evaluateCrawlerAccess } from "./crawlers";
import { assessEeat } from "./eeat";
import { htmlToMarkdown, internalLinks, pageTitle, parseHtml, sitemapLocs, type Doc } from "./html";
import { buildLlmsTxtResult } from "./llms-txt";
import { assessPlatformReadiness } from "./platform";
import { parseRobotsTxt } from "./robots";
import { analyzeSchema, extractSchemas } from "./schema";
import { calculateGeoScore, collectDimensions } from "./score";
import { analyzeTechnical } from "./technical";
import type { AuditPage, AuditResult } from "./types";

export * from "./types";
export { calculateGeoScore, collectDimensions, DIMENSION_WEIGHTS } from "./score";

/**
 * `runAudit` — the orchestrator ported from gtm-agents `runGeoAudit`.
 *
 * Differences from the original, all deliberate:
 *  - every limit is an option (the original hard-coded 49 pages / 5-wide /
 *    30k-char truncation in six places);
 *  - link discovery goes through cheerio and the sitemap, not an `href=` regex;
 *  - robots evaluation is path-level and includes the content prefix;
 *  - a module that fails lands in `degraded` and its dimension drops out of
 *    the composite, instead of contributing a fake zero;
 *  - citability runs pages in parallel;
 *  - per-page structure scores from the shared rule registry come back so the
 *    caller can tell the user *which* page to fix.
 */
export interface AuditOptions {
  model?: TextModel;
  /** Pages beyond the homepage to sample. */
  maxPages?: number;
  concurrency?: number;
  /** Path prefix we plan to publish under (preflight audits); evaluated for crawler access. */
  contentPrefix?: string;
  /** Characters of markdown handed to the model per page. */
  modelMaxChars?: number;
  /** Characters of markdown retained per page in the result. */
  pageMaxChars?: number;
  fetch?: Pick<FetchOptions, "timeoutMs" | "maxBytes" | "allowPrivate" | "fetchImpl" | "userAgent">;
  /** Skip the model-backed modules entirely (deterministic-only preflight). */
  skipModel?: boolean;
  onProgress?: (stage: AuditStage, detail?: string) => void;
}

export type AuditStage =
  | "fetch_home"
  | "discover"
  | "fetch_pages"
  | "crawler_access"
  | "technical"
  | "schema"
  | "llms_txt"
  | "eeat"
  | "citability"
  | "platform"
  | "score";

export interface AuditRun {
  result: AuditResult;
  pages: (AuditPage & { structure: StructureScore })[];
}

export class AuditError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_url" | "blocked" | "unreachable" | "not_html",
  ) {
    super(message);
    this.name = "AuditError";
  }
}

/** Accepts bare domains, adds https, strips fragments and credentials. */
export function normalizeTargetUrl(input: string): URL {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new AuditError(`Not a valid URL: ${input}`, "invalid_url");
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  if (!url.hostname.includes(".")) throw new AuditError(`Not a public hostname: ${url.hostname}`, "invalid_url");
  return url;
}

const PRIORITY_PATHS = [/about/i, /blog|articles|resources|insights|guides|learn/i, /docs|documentation|help/i, /product|features|services|solutions/i, /pricing/i, /contact/i, /customers|case-stud/i, /compare|vs|alternative/i];

/** Order candidate URLs so the sample is representative: one of each section before the long tail. */
export function prioritizePages(urls: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const remaining = urls.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
  for (const re of PRIORITY_PATHS) {
    const hit = remaining.find((u) => re.test(new URL(u).pathname) && !out.includes(u));
    if (hit) out.push(hit);
    if (out.length >= limit) return out;
  }
  for (const u of remaining) {
    if (out.length >= limit) break;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

async function fetchText(url: string, opts: AuditOptions["fetch"]): Promise<{ status: number | null; body: string | null; res?: FetchResult }> {
  try {
    const res = await safeFetch(url, { ...opts, maxRetries: 1, timeoutMs: opts?.timeoutMs ?? 10_000 });
    return { status: res.status, body: res.ok ? res.body : null, res };
  } catch {
    return { status: null, body: null };
  }
}

async function discoverSitemapUrls(origin: string, robotsSitemaps: string[], opts: AuditOptions["fetch"], budget: number): Promise<string[]> {
  const queue = [...robotsSitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const visited = new Set<string>();
  const urls: string[] = [];
  const host = new URL(origin).hostname;
  while (queue.length && visited.size < 5 && urls.length < budget) {
    const sm = queue.shift()!;
    if (visited.has(sm)) continue;
    visited.add(sm);
    if (!checkSsrf(sm).safe) continue;
    const { body } = await fetchText(sm, opts);
    if (!body) continue;
    const { urls: locs, children } = sitemapLocs(body);
    for (const u of locs) {
      try {
        if (new URL(u).hostname === host) urls.push(u);
      } catch {
        /* skip */
      }
    }
    queue.push(...children.slice(0, 3));
  }
  return urls;
}

export async function runAudit(targetUrl: string, options: AuditOptions = {}): Promise<AuditRun> {
  const started = Date.now();
  const model = options.model ?? defaultModel();
  const maxPages = options.maxPages ?? 24;
  const concurrency = options.concurrency ?? 5;
  const modelMaxChars = options.modelMaxChars ?? 6000;
  const pageMaxChars = options.pageMaxChars ?? 30_000;
  const progress = options.onProgress ?? (() => {});
  const degraded: AuditResult["degraded"] = [];
  let llmCalls = 0;

  const target = normalizeTargetUrl(targetUrl);
  const ssrf = checkSsrf(target.href);
  if (!ssrf.safe) throw new AuditError(ssrf.reason ?? "blocked", "blocked");

  // 1. Homepage
  progress("fetch_home", target.href);
  let home: FetchResult;
  try {
    home = await safeFetch(target.href, options.fetch);
  } catch (e) {
    throw new AuditError(`Could not fetch ${target.href}: ${(e as Error).message}`, "unreachable");
  }
  if (!/text\/html|application\/xhtml/i.test(home.contentType ?? "") && !/<html/i.test(home.body.slice(0, 2000))) {
    throw new AuditError(`${home.finalUrl} did not return HTML (${home.contentType ?? "no content-type"})`, "not_html");
  }
  const finalUrl = new URL(home.finalUrl);
  const origin = finalUrl.origin;
  const domain = finalUrl.hostname.replace(/^www\./, "");
  const home$ = parseHtml(home.body);

  // 2. robots.txt / llms.txt / ai.txt — fetched once, used by two modules.
  const [robots, llms, aiTxt] = await Promise.all([
    fetchText(`${origin}/robots.txt`, options.fetch),
    fetchText(`${origin}/llms.txt`, options.fetch),
    fetchText(`${origin}/ai.txt`, options.fetch),
  ]);
  const parsedRobots = robots.body ? parseRobotsTxt(robots.body) : { groups: [], sitemaps: [] };

  // 3. Discover and fetch sample pages.
  progress("discover");
  const linked = internalLinks(home$, home.finalUrl);
  const fromSitemap = linked.length >= maxPages ? [] : await discoverSitemapUrls(origin, parsedRobots.sitemaps, options.fetch, maxPages * 4);
  const candidates = prioritizePages(
    [...linked, ...fromSitemap].filter((u) => u !== home.finalUrl && u !== target.href),
    maxPages,
  );

  progress("fetch_pages", `${candidates.length} candidates`);
  const fetched = await mapConcurrent(candidates, concurrency, async (url) => {
    try {
      const r = await safeFetch(url, { ...options.fetch, maxRetries: 1 });
      if (!r.ok || !/text\/html|application\/xhtml/i.test(r.contentType ?? "")) return null;
      return r;
    } catch {
      return null;
    }
  });

  type Loaded = { res: FetchResult; $: Doc; markdown: string; title: string };
  const loaded: Loaded[] = [{ res: home, $: home$, markdown: htmlToMarkdown(home.body, pageMaxChars), title: pageTitle(home$) }];
  for (const r of fetched) {
    if (!r) continue;
    const $ = parseHtml(r.body);
    loaded.push({ res: r, $, markdown: htmlToMarkdown(r.body, pageMaxChars), title: pageTitle($) });
  }
  const pageUrls = loaded.map((p) => p.res.finalUrl);

  // 4. Deterministic modules. Each is isolated so one throw degrades one dimension.
  progress("crawler_access");
  let crawlerAccess: AuditResult["crawlerAccess"] = null;
  try {
    const samplePaths = pageUrls.map((u) => new URL(u).pathname).slice(0, 12);
    const prefix = options.contentPrefix ? [options.contentPrefix.replace(/\/?$/, "/")] : [];
    crawlerAccess = evaluateCrawlerAccess({
      robotsTxtUrl: `${origin}/robots.txt`,
      robotsTxtStatus: robots.status,
      robotsTxtBody: robots.body,
      paths: [...prefix, ...samplePaths],
      aiSpecificFilesPresent: llms.status === 200 || aiTxt.status === 200,
    });
  } catch (e) {
    degraded.push({ module: "crawlerAccess", reason: (e as Error).message });
  }

  progress("technical");
  let technical: AuditResult["technical"] = null;
  try {
    technical = analyzeTechnical({ html: home.body, $: home$, headers: home.headers, status: home.status, finalUrl: home.finalUrl, sampledUrls: pageUrls });
  } catch (e) {
    degraded.push({ module: "technical", reason: (e as Error).message });
  }

  progress("schema");
  let schema: AuditResult["schema"] = null;
  try {
    schema = analyzeSchema(loaded.map((p) => extractSchemas(p.$, p.res.finalUrl)));
  } catch (e) {
    degraded.push({ module: "schema", reason: (e as Error).message });
  }

  progress("llms_txt");
  let llmsTxt: AuditResult["llmsTxt"] = null;
  try {
    llmsTxt = buildLlmsTxtResult(`${origin}/llms.txt`, llms.status, llms.body);
  } catch (e) {
    degraded.push({ module: "llmsTxt", reason: (e as Error).message });
  }

  // 5. Model-backed modules.
  let eeat: AuditResult["eeat"] = null;
  let citability: AuditResult["citability"] = null;
  let platformReadiness: AuditResult["platformReadiness"] = null;
  const pageInputs = loaded.map((p) => ({ $: p.$, url: p.res.finalUrl, markdown: p.markdown, title: p.title }));

  if (options.skipModel) {
    degraded.push({ module: "citability", reason: "skipped" }, { module: "platformReadiness", reason: "skipped" });
    progress("eeat");
    try {
      const { result } = await assessEeat({ id: "none", complete: async () => { throw new Error("skipped"); } }, pageInputs, { maxChars: modelMaxChars });
      eeat = result;
      degraded.push({ module: "eeat", reason: "model skipped; probe-only score" });
    } catch (e) {
      degraded.push({ module: "eeat", reason: (e as Error).message });
    }
  } else {
    progress("eeat");
    progress("citability");
    const [eeatOut, citOut] = await Promise.allSettled([
      assessEeat(model, pageInputs, { maxChars: modelMaxChars }),
      scoreCitability(model, pageInputs, { concurrency, maxChars: modelMaxChars }),
    ]);
    if (eeatOut.status === "fulfilled") {
      eeat = eeatOut.value.result;
      if (eeatOut.value.usedModel) llmCalls += 1;
      else degraded.push({ module: "eeat", reason: "model unavailable; probe-only score" });
    } else degraded.push({ module: "eeat", reason: String(eeatOut.reason?.message ?? eeatOut.reason) });
    if (citOut.status === "fulfilled") {
      llmCalls += citOut.value.llmCalls;
      if (citOut.value.scoredPages > 0) citability = citOut.value.result;
      else degraded.push({ module: "citability", reason: citOut.value.result.pages[0]?.error ?? "no page could be scored" });
    } else degraded.push({ module: "citability", reason: String(citOut.reason?.message ?? citOut.reason) });

    progress("platform");
    try {
      platformReadiness = await assessPlatformReadiness(model, {
        crawlerSummary: crawlerAccess ? summarizeCrawler(crawlerAccess) : "unavailable",
        schemaSummary: schema ? `${schema.totalScore}/100, format ${schema.format}, types: ${Array.from(new Set(schema.schemasFound.map((s) => s.type))).join(", ") || "none"}; issues: ${schema.issues.slice(0, 4).join("; ") || "none"}` : "unavailable",
        citabilitySummary: citability ? `${citability.averageScore}/100 over ${citability.pages.filter((p) => !p.error).length} pages` : "unavailable",
        eeatSummary: eeat ? `${eeat.totalScore}/100 (E ${eeat.experience} / E ${eeat.expertise} / A ${eeat.authoritativeness} / T ${eeat.trustworthiness})` : "unavailable",
        technicalSummary: technical ? `${technical.totalScore}/100, SSR ${technical.ssrDetected} (${technical.framework}), missing meta: ${technical.metaTags.missing.join(", ") || "none"}, noindex ${technical.noindex}` : "unavailable",
        llmsTxtSummary: llmsTxt ? (llmsTxt.found ? `present, ${llmsTxt.valid ? "valid" : `invalid: ${llmsTxt.issues.slice(0, 3).join("; ")}`}` : "missing") : "unavailable",
      });
      llmCalls += 1;
    } catch (e) {
      degraded.push({ module: "platformReadiness", reason: (e as Error).message });
    }
  }

  // 6. Composite + recommendations from the shared registry.
  progress("score");
  const partial = { crawlerAccess, schema, citability, eeat, technical, platformReadiness, llmsTxt };
  const dims = collectDimensions(partial);
  const { score } = calculateGeoScore(dims);
  const recommendations = runSiteRules(partial);

  const pages = loaded.map((p) => ({
    url: p.res.finalUrl,
    title: p.title,
    status: p.res.status,
    html: p.res.body,
    markdown: p.markdown,
    fetchedAt: new Date().toISOString(),
    structure: runPageRules({ url: p.res.finalUrl, html: p.res.body, $: p.$, markdown: p.markdown, headers: p.res.headers }),
  }));

  const result: AuditResult = {
    targetUrl: target.href,
    finalUrl: home.finalUrl,
    domain,
    geoScore: score,
    dimensions: {
      crawlerAccess: dims.crawlerAccess ?? 0,
      schema: dims.schema ?? 0,
      citability: dims.citability ?? 0,
      eeat: dims.eeat ?? 0,
      technical: dims.technical ?? 0,
      llmsTxt: dims.llmsTxt ?? 0,
    },
    ...partial,
    recommendations,
    degraded,
    pagesAnalyzed: loaded.length,
    pageUrls,
    durationMs: Date.now() - started,
    llmCalls,
    ruleRegistryVersion: RULE_REGISTRY_VERSION,
  };
  return { result, pages };
}

function summarizeCrawler(c: NonNullable<AuditResult["crawlerAccess"]>): string {
  const blocked = c.crawlers.filter((x) => !x.allowed).map((x) => x.name);
  return `${c.totalScore}/100; robots.txt ${c.robotsTxtFound ? "found" : "missing"}; blanket block ${c.blanketBlockDetected}; blocked: ${blocked.join(", ") || "none"}; path blocks: ${c.pathBlocks.length}`;
}
