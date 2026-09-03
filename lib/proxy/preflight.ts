import { evaluateCrawlerAccess } from "@/lib/audit/crawlers";
import { sitemapLocs } from "@/lib/audit/html";
import { parseRobotsTxt } from "@/lib/audit/robots";
import type { CrawlerAccessResult } from "@/lib/audit/types";
import { checkSsrf, safeFetch } from "@/lib/fetch";
import { isWithinPrefix } from "@/lib/tenancy";
import { probeCrawlerAccess, type CrawlerAccessReport } from "./crawler-access";
import { publicOrigin, runHealthCheck, type HealthCheckItem, type HealthOptions, type HealthResult, type HealthSite } from "./health";

/**
 * Onboarding preflight. Before a site goes live under a customer's domain we
 * establish, through their edge: (1) the content prefix is not already
 * occupied by their own pages — a collision would silently shadow them;
 * (2) the rewrite is installed and reaches us with the headers we need;
 * (3) their CSP will not break inlined theme CSS; (4) what their robots.txt
 * and their WAF do to each AI crawler. Only 1–3 block; 4 is the report.
 */

export interface PathCollision {
  /** Their own page answers on the prefix root (not our health JSON). */
  occupied: boolean;
  /** URLs from their sitemap that sit under the prefix. */
  sitemapUrls: string[];
  probe: { url: string; status: number | null; ours: boolean };
}

export interface PreflightResult {
  ok: boolean;
  /** Human-readable reasons the site cannot be activated yet. */
  blocking: string[];
  installed: boolean;
  collisions: PathCollision;
  health: HealthResult;
  robots: CrawlerAccessResult;
  crawlerAccess: CrawlerAccessReport | null;
  checks: HealthCheckItem[];
}

export interface PreflightOptions extends HealthOptions {
  /** Skip the live per-bot probe (fast verification re-runs). */
  crawlerReport?: boolean;
  concurrency?: number;
}

async function text(url: string, opts: PreflightOptions): Promise<{ status: number | null; body: string | null }> {
  if (!checkSsrf(url).safe) return { status: null, body: null };
  try {
    const res = await safeFetch(url, { fetchImpl: opts.fetchImpl, allowPrivate: opts.allowPrivate, timeoutMs: opts.timeoutMs ?? 10_000, maxRetries: 0, maxBytes: 2 * 1024 * 1024, userAgent: "aeo-platform-preflight/1.0 (+https://aeo.app/health)" });
    return { status: res.status, body: res.status === 200 ? res.body : null };
  } catch {
    return { status: null, body: null };
  }
}

/** Their sitemap(s): robots.txt `Sitemap:` lines first, then the conventional locations. One level of index, bounded. */
export async function sitemapUrlsUnderPrefix(origin: string, prefix: string, robotsSitemaps: string[], opts: PreflightOptions, budget = 2000): Promise<string[]> {
  const host = new URL(origin).hostname;
  const queue = [...robotsSitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const visited = new Set<string>();
  const hits = new Set<string>();
  let seen = 0;
  while (queue.length && visited.size < 6 && seen < budget) {
    const sm = queue.shift()!;
    if (visited.has(sm)) continue;
    visited.add(sm);
    // Our own sitemap under the prefix is not evidence of a collision.
    if (pathOf(sm, host) && isWithinPrefix(pathOf(sm, host)!, prefix)) continue;
    const { body } = await text(sm, opts);
    if (!body) continue;
    const { urls, children } = sitemapLocs(body);
    for (const u of urls) {
      seen++;
      const p = pathOf(u, host);
      if (p && isWithinPrefix(p, prefix)) hits.add(u);
    }
    queue.push(...children.slice(0, 4));
  }
  return [...hits].sort();
}

function pathOf(url: string, host: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname === host ? u.pathname : null;
  } catch {
    return null;
  }
}

export async function runPreflight(site: HealthSite, opts: PreflightOptions = {}): Promise<PreflightResult> {
  const origin = publicOrigin(site);
  const checks: HealthCheckItem[] = [];
  const blocking: string[] = [];

  // ── their robots.txt: sitemap pointers + AI crawler rules ──────────────────
  const robotsUrl = `${origin}/robots.txt`;
  const robotsTxt = await text(robotsUrl, opts);
  const parsedRobots = robotsTxt.body ? parseRobotsTxt(robotsTxt.body) : null;
  const robots = evaluateCrawlerAccess({ robotsTxtUrl: robotsUrl, robotsTxtStatus: robotsTxt.status, robotsTxtBody: robotsTxt.body, paths: ["/", `${site.pathPrefix}/`], aiSpecificFilesPresent: false });

  // ── path collision ─────────────────────────────────────────────────────────
  const sitemapUrls = await sitemapUrlsUnderPrefix(origin, site.pathPrefix, parsedRobots?.sitemaps ?? [], opts);
  const probeUrl = `${origin}${site.pathPrefix}/aeo-health`;
  const probe = await text(probeUrl, opts);
  let ours = false;
  if (probe.body) {
    try {
      ours = (JSON.parse(probe.body) as { siteId?: string }).siteId === site.id;
    } catch {
      ours = false;
    }
  }
  const occupied = probe.status === 200 && !ours;
  const collisions: PathCollision = { occupied, sitemapUrls, probe: { url: probeUrl, status: probe.status, ours } };
  checks.push({ key: "path_collision", ok: !occupied && sitemapUrls.length === 0, severity: "fail", detail: { occupied, sitemapUrls: sitemapUrls.slice(0, 50), sitemapUrlCount: sitemapUrls.length } });
  if (occupied) blocking.push(`${site.pathPrefix} already serves one of their pages; choose another prefix or move it`);
  if (sitemapUrls.length) blocking.push(`${sitemapUrls.length} URL(s) in their sitemap live under ${site.pathPrefix}`);

  // ── install + headers + CSP, through their edge ────────────────────────────
  const installed = ours;
  checks.push({ key: "installed", ok: installed, severity: "fail", detail: { url: probeUrl, status: probe.status, hint: installed ? null : probe.status === 404 ? "the rewrite is not installed or does not cover the prefix" : "the prefix answers, but not with our health response" } });
  if (!installed) blocking.push(`the rewrite for ${site.pathPrefix} does not reach us (http ${probe.status ?? "unreachable"})`);
  const health = await runHealthCheck(site, { ...opts, expectIndexable: false });
  checks.push(...health.checks);
  for (const f of health.failed) if (f !== "health_endpoint" || installed) blocking.push(`health check failed: ${f}`);

  // ── the AI Crawler Access Report ───────────────────────────────────────────
  const targetUrl = opts.articlePath ? `${origin}${opts.articlePath}` : probeUrl;
  const crawlerAccess = opts.crawlerReport === false || !installed ? null : await probeCrawlerAccess(targetUrl, { fetchImpl: opts.fetchImpl, allowPrivate: opts.allowPrivate, robotsTxt: robotsTxt.body, concurrency: opts.concurrency, timeoutMs: opts.timeoutMs });
  if (crawlerAccess) {
    checks.push({ key: "ai_crawlers", ok: crawlerAccess.summary.tier1Blocked.length === 0, severity: "warn", detail: { score: crawlerAccess.summary.score, tier1Blocked: crawlerAccess.summary.tier1Blocked, robotsDisallowed: crawlerAccess.summary.robotsDisallowed } });
  }

  return { ok: blocking.length === 0, blocking: [...new Set(blocking)], installed, collisions, health, robots, crawlerAccess, checks };
}
