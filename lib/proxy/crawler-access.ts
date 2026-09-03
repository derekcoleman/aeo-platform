import { AI_CRAWLERS, type AiCrawler } from "@/lib/audit/crawlers";
import { evaluatePath, parseRobotsTxt, type ParsedRobots } from "@/lib/audit/robots";
import { mapConcurrent, RetryableError, safeFetch, type FetchResult } from "@/lib/fetch";

/**
 * The AI Crawler Access Report: fetch one URL through the customer's edge
 * once per AI crawler user agent and say, per bot, whether the edge let it
 * through, blocked it, or served a challenge. This is the most common
 * real-world reason the product "does not work" — Cloudflare's "Block AI
 * Scrapers" toggle, Bot Fight Mode, a WAF rule, or a `Disallow: GPTBot`
 * someone added in 2023 and forgot — and a robots.txt reading alone cannot
 * see any of it. The robots verdict rides alongside so the report can say
 * "the WAF allows it but robots.txt disallows it" in one line.
 *
 * A live probe, so it is honest about what it is: one request, one moment,
 * from one network. Re-runnable, and stored whole so runs can be diffed.
 */

export type CrawlerVerdict = "allow" | "block" | "challenge" | "error";

export interface CrawlerProbe {
  name: string;
  userAgent: string;
  tier: AiCrawler["tier"];
  operator: string;
  purpose: AiCrawler["purpose"];
  verdict: CrawlerVerdict;
  status: number | null;
  reason: string;
  /** What robots.txt says for this path, independent of the edge. */
  robots: "allowed" | "disallowed" | "unknown";
  robotsRule: string | null;
  durationMs: number | null;
}

export interface CrawlerAccessReport {
  url: string;
  path: string;
  probedAt: string;
  baseline: { status: number | null; bytes: number; reason: string | null };
  results: CrawlerProbe[];
  summary: {
    allowed: number;
    blocked: number;
    challenged: number;
    errored: number;
    /** Tier-1 bots the edge or robots.txt keeps out — the ones that cost citations. */
    tier1Blocked: string[];
    robotsDisallowed: string[];
    /** 0–100, weighted by tier; the number a sales deck can quote. */
    score: number;
  };
}

/** Body / header signatures of a bot-management interstitial rather than the page. */
const CHALLENGE_SIGNATURES = [
  /just a moment\.\.\./i,
  /cf-chl-|_cf_chl_opt|challenge-platform|cf_chl_/i,
  /checking (your|the) browser before accessing/i,
  /enable javascript and cookies to continue/i,
  /attention required!\s*\|\s*cloudflare/i,
  /<title>\s*access denied\s*<\/title>/i,
  /captcha/i,
  /_px(vid|hd)|perimeterx|px-captcha/i,
  /incapsula|_incap_ses|imperva/i,
  /aws-waf-token|awswafintegration|challenge\.js/i,
  /datadome/i,
  /akamai.*bot ?manager|ak_bmsc/i,
];

export interface ClassifyInput {
  status: number | null;
  headers: Headers | null;
  body: string;
  baselineBytes: number;
  error?: string | null;
}

/** Pure: status + headers + body → verdict. Exported so the classifier is testable without a network. */
export function classifyProbe(input: ClassifyInput): { verdict: CrawlerVerdict; reason: string } {
  if (input.status == null) return { verdict: "error", reason: input.error ?? "no response" };
  const mitigated = input.headers?.get("cf-mitigated");
  const challengeSig = mitigated === "challenge" || CHALLENGE_SIGNATURES.some((re) => re.test(input.body));
  const s = input.status;
  if (s === 401 || s === 403 || s === 451) return { verdict: "block", reason: `http ${s}${input.headers?.get("server") ? ` from ${input.headers.get("server")}` : ""}` };
  if (s === 429) return { verdict: "challenge", reason: "rate limited (http 429)" };
  if (challengeSig) return { verdict: "challenge", reason: s >= 200 && s < 300 ? "challenge interstitial served with http 200" : `challenge interstitial (http ${s})` };
  if (s === 503) return { verdict: "challenge", reason: "http 503 — bot management or overload; re-run to confirm" };
  if (s >= 500) return { verdict: "error", reason: `http ${s}` };
  if (s >= 400) return { verdict: "block", reason: `http ${s}` };
  if (s >= 300) return { verdict: "error", reason: `unfollowed redirect (http ${s})` };
  // A 200 that is a fraction of what a browser gets is a different page — a
  // soft block ("Access denied" HTML, an empty shell) rather than the content.
  if (input.baselineBytes > 0 && input.body.length < input.baselineBytes * 0.25) {
    return { verdict: "block", reason: `served ${input.body.length} bytes vs ${input.baselineBytes} for a browser` };
  }
  return { verdict: "allow", reason: `http ${s}` };
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  crawlers?: AiCrawler[];
  /** The customer's robots.txt body, already fetched; null = not found; undefined = unknown. */
  robotsTxt?: string | null;
  concurrency?: number;
  timeoutMs?: number;
  allowPrivate?: boolean;
  now?: () => Date;
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function probe(url: string, userAgent: string, opts: ProbeOptions): Promise<{ res: FetchResult | null; status: number | null; error: string | null }> {
  try {
    // No retries: a 429 or 503 IS the finding, not a transient to smooth over.
    const res = await safeFetch(url, { userAgent, maxRetries: 0, maxRedirects: 3, timeoutMs: opts.timeoutMs ?? 12_000, maxBytes: 512 * 1024, fetchImpl: opts.fetchImpl, allowPrivate: opts.allowPrivate });
    return { res, status: res.status, error: null };
  } catch (e) {
    // safeFetch surfaces 429/503 as a RetryableError; with retries off that is the verdict.
    const m = e instanceof RetryableError ? /upstream (\d{3})/.exec(e.message) : null;
    if (m) return { res: null, status: Number(m[1]), error: null };
    return { res: null, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function robotsVerdict(robots: ParsedRobots | null, userAgent: string, path: string): { robots: CrawlerProbe["robots"]; rule: string | null } {
  if (!robots) return { robots: "unknown", rule: null };
  const v = evaluatePath(robots, userAgent, path);
  return { robots: v.allowed ? "allowed" : "disallowed", rule: v.rule?.line ?? null };
}

export async function probeCrawlerAccess(url: string, opts: ProbeOptions = {}): Promise<CrawlerAccessReport> {
  const crawlers = opts.crawlers ?? AI_CRAWLERS;
  const path = new URL(url).pathname || "/";
  const robots = opts.robotsTxt ? parseRobotsTxt(opts.robotsTxt) : null;
  const base = await probe(url, BROWSER_UA, opts);
  const baselineBytes = base.res?.body.length ?? 0;
  const results = await mapConcurrent(crawlers, opts.concurrency ?? 4, async (c): Promise<CrawlerProbe> => {
    const { res, status, error } = await probe(url, `Mozilla/5.0 (compatible; ${c.userAgent}/1.0; +https://aeo.app/crawler-report)`, opts);
    const { verdict, reason } = classifyProbe({ status, headers: res?.headers ?? null, body: res?.body ?? "", baselineBytes, error });
    const rv = robotsVerdict(robots, c.userAgent, path);
    return { name: c.name, userAgent: c.userAgent, tier: c.tier, operator: c.operator, purpose: c.purpose, verdict, status, reason, robots: rv.robots, robotsRule: rv.rule, durationMs: res?.durationMs ?? null };
  });
  return {
    url,
    path,
    probedAt: (opts.now?.() ?? new Date()).toISOString(),
    baseline: { status: base.res?.status ?? null, bytes: baselineBytes, reason: base.error },
    results,
    summary: summarize(results),
  };
}

const TIER_WEIGHT: Record<AiCrawler["tier"], number> = { 1: 70, 2: 20, 3: 10 };

export function summarize(results: CrawlerProbe[]): CrawlerAccessReport["summary"] {
  const count = (v: CrawlerVerdict) => results.filter((r) => r.verdict === v).length;
  const reachable = (r: CrawlerProbe) => r.verdict === "allow" && r.robots !== "disallowed";
  // Weighted by tier, normalised over the tiers actually probed.
  let score = 0;
  let weight = 0;
  for (const tier of [1, 2, 3] as const) {
    const inTier = results.filter((r) => r.tier === tier);
    if (inTier.length === 0) continue;
    score += (inTier.filter(reachable).length / inTier.length) * TIER_WEIGHT[tier];
    weight += TIER_WEIGHT[tier];
  }
  score = weight ? (score / weight) * 100 : 0;
  return {
    allowed: count("allow"),
    blocked: count("block"),
    challenged: count("challenge"),
    errored: count("error"),
    tier1Blocked: results.filter((r) => r.tier === 1 && !reachable(r)).map((r) => r.name),
    robotsDisallowed: results.filter((r) => r.robots === "disallowed").map((r) => r.name),
    score: Math.round(score),
  };
}
