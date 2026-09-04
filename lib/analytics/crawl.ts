import { createHash } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { appDb } from "@/lib/db/app";
import { BOT_CATALOG, classifyUserAgent, verifyBotIp, type BotPurpose } from "./bots";

/**
 * Crawl telemetry: what the customer's Worker posts, what our own origin sees,
 * and the rollup the dashboard reads.
 *
 * Coverage is the honest part. A Mode A Worker reports every hit including
 * cache hits; every other install mode only ever sees origin misses. The
 * summary says which one a site has, so partial data is never presented as
 * complete.
 */

export const CRAWL_SOURCES = ["worker", "origin", "profound"] as const;
export type CrawlSource = (typeof CRAWL_SOURCES)[number];
const PURPOSES = ["train", "search_index", "live_fetch", "other"] as const;

export const crawlEventSchema = z.object({
  ts: z.string().optional(),
  path: z.string().min(1).max(2048),
  botFamily: z.string().max(64).optional(),
  purpose: z.enum(PURPOSES).optional(),
  ua: z.string().max(2048).nullable().optional(),
  status: z.number().int().nullable().optional(),
  cacheStatus: z.string().max(32).nullable().optional(),
  country: z.string().max(8).nullable().optional(),
  ip: z.string().max(64).nullable().optional(),
  source: z.enum(CRAWL_SOURCES).optional(),
});
export type CrawlEventInput = z.infer<typeof crawlEventSchema>;

export const crawlIngestSchema = z.object({
  siteId: z.guid(),
  events: z.array(crawlEventSchema).min(1).max(500),
});

export const siteAlertSchema = z.object({
  siteId: z.guid(),
  kind: z.string().min(1).max(64),
  path: z.string().max(2048).nullable().optional(),
  detail: z.unknown().optional(),
});

export interface CrawlRow {
  ts: Date;
  path: string;
  bot_family: string;
  purpose: BotPurpose;
  verified: boolean;
  ua_raw: string | null;
  ip_hash: string | null;
  country: string | null;
  status: number | null;
  cache_status: string | null;
  source: CrawlSource;
}

export interface PrepareOptions {
  ranges: Record<string, string[]>;
  salt: string;
  now?: Date;
  defaultSource?: CrawlSource;
}

/** Salted, truncated: enough to count distinct sources, never enough to recover the address. */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 24);
}

const MAX_PAST_MS = 7 * 24 * 3600_000;
const MAX_FUTURE_MS = 5 * 60_000;

/** Normalise, classify, verify and hash. Events that are not an AI crawler are dropped, never stored. */
export function prepareCrawlRows(events: CrawlEventInput[], opts: PrepareOptions): CrawlRow[] {
  const now = opts.now ?? new Date();
  const rows: CrawlRow[] = [];
  for (const e of events) {
    const classified = e.botFamily ? { family: e.botFamily, purpose: e.purpose ?? (BOT_CATALOG.find((b) => b.family === e.botFamily)?.purpose ?? "other") } : classifyUserAgent(e.ua);
    if (!classified) continue;
    let ts = e.ts ? new Date(e.ts) : now;
    if (Number.isNaN(ts.getTime()) || ts.getTime() < now.getTime() - MAX_PAST_MS || ts.getTime() > now.getTime() + MAX_FUTURE_MS) ts = now;
    const path = e.path.split("?")[0]!.split("#")[0]!.slice(0, 2048) || "/";
    const verified = verifyBotIp(classified.family, e.ip, opts.ranges) === true;
    rows.push({
      ts,
      path,
      bot_family: classified.family,
      purpose: classified.purpose,
      verified,
      ua_raw: e.ua ? e.ua.slice(0, 1024) : null,
      ip_hash: e.ip ? hashIp(e.ip, opts.salt) : null,
      country: e.country ?? null,
      status: e.status ?? null,
      cache_status: e.cacheStatus ?? null,
      source: e.source ?? opts.defaultSource ?? "worker",
    });
  }
  return rows;
}

/** One statement for the batch; content_id is resolved from the published page at the same path. */
export async function insertCrawlEvents(siteId: string, rows: CrawlRow[], sql: postgres.Sql = appDb()): Promise<number> {
  if (rows.length === 0) return 0;
  const col = <K extends keyof CrawlRow>(k: K) => rows.map((r) => r[k]);
  await sql`
    insert into analytics.crawl_events (site_id, ts, path, content_id, bot_family, purpose, verified, ua_raw, ip_hash, country, status, cache_status, source)
    select ${siteId}, e.ts, e.path, p.content_item_id, e.bot_family, e.purpose::analytics.bot_purpose, e.verified, e.ua_raw, e.ip_hash, e.country, e.status, e.cache_status, e.source::analytics.crawl_source
    from unnest(
      ${sql.array(col("ts").map((d) => d.toISOString()))}::timestamptz[],
      ${sql.array(col("path"))}::text[],
      ${sql.array(col("bot_family"))}::text[],
      ${sql.array(col("purpose"))}::text[],
      ${sql.array(col("verified"))}::boolean[],
      ${sql.array(col("ua_raw"))}::text[],
      ${sql.array(col("ip_hash"))}::text[],
      ${sql.array(col("country"))}::text[],
      ${sql.array(col("status"))}::int[],
      ${sql.array(col("cache_status"))}::text[],
      ${sql.array(col("source"))}::text[]
    ) as e(ts, path, bot_family, purpose, verified, ua_raw, ip_hash, country, status, cache_status, source)
    left join content.published_pages p on p.site_id = ${siteId} and p.path = e.path`;
  return rows.length;
}

export async function insertSiteAlert(siteId: string, alert: { kind: string; path?: string | null; detail?: unknown }, sql: postgres.Sql = appDb()): Promise<void> {
  const detail = alert.detail && typeof alert.detail === "object" && !Array.isArray(alert.detail) ? alert.detail : { value: alert.detail ?? null };
  await sql`insert into ops.site_alerts (site_id, kind, path, detail) values (${siteId}, ${alert.kind.slice(0, 64)}, ${alert.path ?? null}, ${sql.json(detail as never)})`;
}

/** Re-aggregates the last `days` days; idempotent, so the hourly job can overlap itself. */
export async function rollupCrawlDaily(days = 2, sql: postgres.Sql = appDb()): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    with agg as (
      select org_id, site_id, (ts at time zone 'UTC')::date as day, bot_family, purpose, source, path,
             count(*)::int as hits, count(*) filter (where verified)::int as verified_hits
      from analytics.crawl_events
      where ts >= now() - make_interval(days => ${days})
      group by org_id, site_id, (ts at time zone 'UTC')::date, bot_family, purpose, source, path
    ), up as (
      insert into analytics.crawl_daily (org_id, site_id, day, bot_family, purpose, source, path, hits, verified_hits)
      select org_id, site_id, day, bot_family, purpose, source, path, hits, verified_hits from agg
      on conflict (site_id, day, bot_family, source, path) do update
        set hits = excluded.hits, verified_hits = excluded.verified_hits, purpose = excluded.purpose, updated_at = now()
      returning 1
    )
    select count(*)::int as n from up`;
  return rows[0]?.n ?? 0;
}

export async function loadBotRanges(sql: postgres.Sql = appDb()): Promise<Record<string, string[]>> {
  const rows = await sql<{ family: string; ip_ranges: string[] }[]>`select family, ip_ranges::text[] as ip_ranges from ops.bots`;
  const out: Record<string, string[]> = {};
  for (const r of rows) out[r.family] = r.ip_ranges ?? [];
  return out;
}

export async function saveBotRanges(family: string, ranges: string[], sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update ops.bots set ip_ranges = ${sql.array(ranges)}::cidr[], ranges_updated_at = now(), updated_at = now() where family = ${family}`;
}

export interface BotCatalogRow {
  family: string;
  operator: string;
  purpose: BotPurpose;
  ranges_url: string | null;
  range_count: number;
  ranges_updated_at: string | Date | null;
}

export async function listBotCatalog(sql: postgres.Sql = appDb()): Promise<BotCatalogRow[]> {
  return sql<BotCatalogRow[]>`
    select family, operator, purpose, ranges_url, coalesce(array_length(ip_ranges, 1), 0)::int as range_count, ranges_updated_at
    from ops.bots order by purpose, family`;
}

// ── dashboard read model ────────────────────────────────────────────────────

export type CrawlCoverage = "full" | "partial" | "none";

export interface CrawlSummary {
  coverage: CrawlCoverage;
  /** Hits per purpose in the last 24h and 7d, with the verified share. */
  byPurpose: { purpose: BotPurpose; hits24h: number; hits7d: number; verified7d: number }[];
  /** Families seen in the last 30 days. */
  byFamily: { bot_family: string; purpose: BotPurpose; hits: number; verified_hits: number; last_seen: string | Date }[];
  /** Pages a model fetched mid-answer in the last 7 days. */
  liveFetchPaths: { path: string; hits: number; last_seen: string | Date; title: string | null }[];
  recentLive: { ts: string | Date; path: string; bot_family: string; verified: boolean; cache_status: string | null }[];
}

export async function crawlSummary(siteId: string, sql: postgres.Sql = appDb()): Promise<CrawlSummary> {
  const [sources, byPurpose, byFamily, liveFetchPaths, recentLive] = await Promise.all([
    sql<{ source: CrawlSource }[]>`select distinct source from analytics.crawl_events where site_id = ${siteId} and ts >= now() - interval '7 days'`,
    sql<{ purpose: BotPurpose; hits24h: number; hits7d: number; verified7d: number }[]>`
      select purpose,
             count(*) filter (where ts >= now() - interval '24 hours')::int as "hits24h",
             count(*)::int as "hits7d",
             count(*) filter (where verified)::int as "verified7d"
      from analytics.crawl_events where site_id = ${siteId} and ts >= now() - interval '7 days'
      group by purpose`,
    sql<CrawlSummary["byFamily"]>`
      select bot_family, purpose, count(*)::int as hits, count(*) filter (where verified)::int as verified_hits, max(ts) as last_seen
      from analytics.crawl_events where site_id = ${siteId} and ts >= now() - interval '30 days'
      group by bot_family, purpose order by hits desc limit 25`,
    sql<CrawlSummary["liveFetchPaths"]>`
      select e.path, count(*)::int as hits, max(e.ts) as last_seen, max(ci.title) as title
      from analytics.crawl_events e
      left join content.content_items ci on ci.id = e.content_id
      where e.site_id = ${siteId} and e.purpose = 'live_fetch' and e.ts >= now() - interval '7 days'
      group by e.path order by hits desc limit 15`,
    sql<CrawlSummary["recentLive"]>`
      select ts, path, bot_family, verified, cache_status from analytics.crawl_events
      where site_id = ${siteId} and purpose = 'live_fetch' order by ts desc limit 20`,
  ]);
  const seen = new Set(sources.map((s) => s.source));
  const coverage: CrawlCoverage = seen.has("worker") ? "full" : seen.size > 0 ? "partial" : "none";
  return { coverage, byPurpose, byFamily, liveFetchPaths, recentLive };
}
