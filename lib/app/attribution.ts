import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Per-asset attribution: three independent signals per published piece,
 * each from its own table, never estimated.
 *  - AI Overview citations (native providers only; Profound is enrichment)
 *    now versus the 30 days before publish — the "before" that makes a
 *    lift claim honest.
 *  - live_fetch crawler hits: a model reading the page mid-answer.
 *  - AI-referral sessions from GA4 and Search Console clicks/impressions.
 * Three agreeing is a defensible claim; one alone is a vanity metric.
 */

export interface AssetAttribution {
  id: string;
  title: string | null;
  slug: string;
  path: string | null;
  published_at: string | Date | null;
  aio_questions_30d: number;
  aio_questions_baseline: number;
  live_fetch_7d: number;
  live_fetch_30d: number;
  ai_sessions_30d: number;
  gsc_clicks_28d: number;
  gsc_impressions_28d: number;
}

export async function assetAttribution(siteId: string, limit = 100, sql: postgres.Sql = appDb()): Promise<AssetAttribution[]> {
  return sql<AssetAttribution[]>`
    with items as (
      select ci.id, ci.title, ci.slug, ci.published_at, p.path
      from content.content_items ci
      left join content.published_pages p on p.content_item_id = ci.id and p.site_id = ci.site_id
      where ci.site_id = ${siteId} and ci.status = 'published'
    )
    select i.id, i.title, i.slug, i.path, i.published_at,
      (select count(distinct s.question_id)::int from measure.serp_citations c join measure.serp_snapshots s on s.id = c.serp_snapshot_id
        where c.content_id = i.id and c.is_owned and c.surface = 'ai_overview' and s.provider in ('dataforseo', 'serpapi') and s.fetched_at >= now() - interval '30 days') as aio_questions_30d,
      (select count(distinct s.question_id)::int from measure.serp_citations c join measure.serp_snapshots s on s.id = c.serp_snapshot_id
        where c.content_id = i.id and c.is_owned and c.surface = 'ai_overview' and s.provider in ('dataforseo', 'serpapi')
          and i.published_at is not null and s.fetched_at < i.published_at and s.fetched_at >= i.published_at - interval '30 days') as aio_questions_baseline,
      (select count(*)::int from analytics.crawl_events e where e.content_id = i.id and e.purpose = 'live_fetch' and e.ts >= now() - interval '7 days') as live_fetch_7d,
      (select count(*)::int from analytics.crawl_events e where e.content_id = i.id and e.purpose = 'live_fetch' and e.ts >= now() - interval '30 days') as live_fetch_30d,
      coalesce((select sum((m.metrics->>'sessions')::numeric) from measure.external_metrics m
        where m.site_id = ${siteId} and m.surface = 'ga4_referral' and (m.content_id = i.id or m.dimension->>'path' = i.path) and m.date >= current_date - 30), 0)::float as ai_sessions_30d,
      coalesce((select sum((m.metrics->>'clicks')::numeric) from measure.external_metrics m
        where m.site_id = ${siteId} and m.surface = 'gsc_page' and (m.content_id = i.id or m.dimension->>'path' = i.path) and m.date >= current_date - 28), 0)::float as gsc_clicks_28d,
      coalesce((select sum((m.metrics->>'impressions')::numeric) from measure.external_metrics m
        where m.site_id = ${siteId} and m.surface = 'gsc_page' and (m.content_id = i.id or m.dimension->>'path' = i.path) and m.date >= current_date - 28), 0)::float as gsc_impressions_28d
    from items i
    order by i.published_at desc nulls last
    limit ${limit}`;
}

export interface SiteSignals {
  ai_sessions_30d: number;
  ai_sessions_prev_30d: number;
  live_fetch_30d: number;
  live_fetch_prev_30d: number;
  gsc_clicks_28d: number;
  has_ga4: boolean;
  has_gsc: boolean;
}

export async function siteSignals(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteSignals> {
  const [row] = await sql<SiteSignals[]>`
    select coalesce((select sum((metrics->>'sessions')::numeric) from measure.external_metrics where site_id = ${siteId} and surface = 'ga4_referral' and date >= current_date - 30), 0)::float as ai_sessions_30d,
           coalesce((select sum((metrics->>'sessions')::numeric) from measure.external_metrics where site_id = ${siteId} and surface = 'ga4_referral' and date >= current_date - 60 and date < current_date - 30), 0)::float as ai_sessions_prev_30d,
           (select count(*)::int from analytics.crawl_events where site_id = ${siteId} and purpose = 'live_fetch' and ts >= now() - interval '30 days') as live_fetch_30d,
           (select count(*)::int from analytics.crawl_events where site_id = ${siteId} and purpose = 'live_fetch' and ts >= now() - interval '60 days' and ts < now() - interval '30 days') as live_fetch_prev_30d,
           coalesce((select sum((metrics->>'clicks')::numeric) from measure.external_metrics where site_id = ${siteId} and surface in ('gsc_page', 'gsc_query') and date >= current_date - 28), 0)::float as gsc_clicks_28d,
           exists (select 1 from measure.external_metrics where site_id = ${siteId} and provider = 'ga4') as has_ga4,
           exists (select 1 from measure.external_metrics where site_id = ${siteId} and provider = 'gsc') as has_gsc`;
  return row ?? { ai_sessions_30d: 0, ai_sessions_prev_30d: 0, live_fetch_30d: 0, live_fetch_prev_30d: 0, gsc_clicks_28d: 0, has_ga4: false, has_gsc: false };
}

/** How many of the three signals moved in the asset's favour. */
export function signalsAgreeing(a: AssetAttribution): number {
  let n = 0;
  if (a.aio_questions_30d > a.aio_questions_baseline) n++;
  if (a.live_fetch_30d > 0) n++;
  if (a.ai_sessions_30d > 0 || a.gsc_clicks_28d > 0) n++;
  return n;
}
