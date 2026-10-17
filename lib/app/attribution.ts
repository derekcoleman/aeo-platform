import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { METHODOLOGY_VERSION } from "./methodology";

/**
 * Per-asset attribution: three independent signals per published piece,
 * each from its own table, never estimated.
 *  - AI Overview citations (our own trackers only, measure.v_native_aio;
 *    Profound is enrichment and answer probes are reported on their own)
 *    now versus the 30 days before publish — the "before" that makes a
 *    lift claim honest.
 *  - live_fetch crawler hits: a model reading the page mid-answer.
 *  - AI-referral sessions from GA4 and Search Console clicks/impressions.
 * Three agreeing is a defensible claim; one alone is a vanity metric.
 *
 * Connector rows count for an asset through `content_id` only, which
 * resolveMetricContentIds (lib/connectors/store.ts) sets from the page each
 * row names, after every Google sync and nightly.
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
      (select count(distinct s.question_id)::int from measure.serp_citations c join measure.v_native_aio s on s.id = c.serp_snapshot_id
        where c.content_id = i.id and c.is_owned and c.surface = 'ai_overview' and s.fetched_at >= now() - interval '30 days') as aio_questions_30d,
      (select count(distinct s.question_id)::int from measure.serp_citations c join measure.v_native_aio s on s.id = c.serp_snapshot_id
        where c.content_id = i.id and c.is_owned and c.surface = 'ai_overview'
          and i.published_at is not null and s.fetched_at < i.published_at and s.fetched_at >= i.published_at - interval '30 days') as aio_questions_baseline,
      (select count(*)::int from analytics.crawl_events e where e.content_id = i.id and e.purpose = 'live_fetch' and e.ts >= now() - interval '7 days') as live_fetch_7d,
      (select count(*)::int from analytics.crawl_events e where e.content_id = i.id and e.purpose = 'live_fetch' and e.ts >= now() - interval '30 days') as live_fetch_30d,
      coalesce((select sum((m.metrics->>'sessions')::numeric) from measure.external_metrics m
        where m.site_id = ${siteId} and m.surface = 'ga4_referral' and m.content_id = i.id and m.date >= current_date - 30), 0)::float as ai_sessions_30d,
      coalesce((select sum((m.metrics->>'clicks')::numeric) from measure.external_metrics m
        where m.site_id = ${siteId} and m.surface = 'gsc_page' and m.content_id = i.id and m.date >= current_date - 28), 0)::float as gsc_clicks_28d,
      coalesce((select sum((m.metrics->>'impressions')::numeric) from measure.external_metrics m
        where m.site_id = ${siteId} and m.surface = 'gsc_page' and m.content_id = i.id and m.date >= current_date - 28), 0)::float as gsc_impressions_28d
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
  /** How these numbers are computed; see lib/app/methodology.ts. */
  methodology_version: string;
}

/**
 * Site totals. Search Console clicks are the `gsc_page` rows alone: the
 * `gsc_query` rows report the same clicks cut by query, and summing both
 * counted every click twice.
 */
export async function siteSignals(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteSignals> {
  const [row] = await sql<Omit<SiteSignals, "methodology_version">[]>`
    select coalesce((select sum((metrics->>'sessions')::numeric) from measure.external_metrics where site_id = ${siteId} and surface = 'ga4_referral' and date >= current_date - 30), 0)::float as ai_sessions_30d,
           coalesce((select sum((metrics->>'sessions')::numeric) from measure.external_metrics where site_id = ${siteId} and surface = 'ga4_referral' and date >= current_date - 60 and date < current_date - 30), 0)::float as ai_sessions_prev_30d,
           (select count(*)::int from analytics.crawl_events where site_id = ${siteId} and purpose = 'live_fetch' and ts >= now() - interval '30 days') as live_fetch_30d,
           (select count(*)::int from analytics.crawl_events where site_id = ${siteId} and purpose = 'live_fetch' and ts >= now() - interval '60 days' and ts < now() - interval '30 days') as live_fetch_prev_30d,
           coalesce((select sum((metrics->>'clicks')::numeric) from measure.external_metrics where site_id = ${siteId} and surface = 'gsc_page' and date >= current_date - 28), 0)::float as gsc_clicks_28d,
           exists (select 1 from measure.external_metrics where site_id = ${siteId} and provider = 'ga4') as has_ga4,
           exists (select 1 from measure.external_metrics where site_id = ${siteId} and provider = 'gsc') as has_gsc`;
  return { ...(row ?? { ai_sessions_30d: 0, ai_sessions_prev_30d: 0, live_fetch_30d: 0, live_fetch_prev_30d: 0, gsc_clicks_28d: 0, has_ga4: false, has_gsc: false }), methodology_version: METHODOLOGY_VERSION };
}

/** How many of the three signals moved in the asset's favour. */
export function signalsAgreeing(a: AssetAttribution): number {
  let n = 0;
  if (a.aio_questions_30d > a.aio_questions_baseline) n++;
  if (a.live_fetch_30d > 0) n++;
  if (a.ai_sessions_30d > 0 || a.gsc_clicks_28d > 0) n++;
  return n;
}
