import type postgres from "postgres";

/**
 * The read models as they stood before methodology 2026-10-r1, kept only so a
 * restatement can show the number a customer saw next to the one they see
 * now. Nothing else may read these; they are wrong in the ways
 * METHODOLOGY_CHANGES lists.
 */

/** Demand's gap list: gaps from the newest snapshot that had an AI Overview, however old and whatever came after it. */
export async function legacyOpenGaps(siteId: string, sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    with latest as (
      select distinct on (question_id) id, question_id
      from measure.serp_snapshots
      where site_id = ${siteId} and aio_triggered is true and provider in ('dataforseo', 'serpapi')
      order by question_id, fetched_at desc
    )
    select count(*)::int as n from latest l
    join measure.questions q on q.id = l.question_id
    where not q.excluded
      and exists (select 1 from measure.serp_citations c where c.serp_snapshot_id = l.id and c.surface = 'ai_overview')
      and not exists (select 1 from measure.serp_citations o where o.serp_snapshot_id = l.id and o.surface = 'ai_overview' and o.is_owned)`;
  return row?.n ?? 0;
}

/**
 * Strategy's per-topic gaps, summed over the site's topics: the latest native
 * snapshot whatever it showed, but however old, and excluded questions
 * counted.
 */
export async function legacyTopicGaps(siteId: string, sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    with latest as (
      select distinct on (s.question_id) s.question_id, s.id, s.aio_triggered
      from measure.serp_snapshots s where s.site_id = ${siteId} and s.provider in ('dataforseo', 'serpapi')
      order by s.question_id, s.fetched_at desc
    )
    select count(*)::int as n
    from measure.questions q
    join measure.topics t on t.id = q.topic_id and t.site_id = ${siteId}
    join latest l on l.question_id = q.id
    where q.site_id = ${siteId} and l.aio_triggered
      and not exists (select 1 from measure.serp_citations c where c.serp_snapshot_id = l.id and c.surface = 'ai_overview' and c.is_owned)
      and exists (select 1 from measure.serp_citations c where c.serp_snapshot_id = l.id and c.surface = 'ai_overview')`;
  return row?.n ?? 0;
}

/**
 * Demand's 7-day snapshot count, Profound's synced rows included. Answer
 * probes came later and were never on that page, so they are left out of
 * the old number too: the restatement explains the Profound rows, not them.
 */
export async function legacySnapshots7d(siteId: string, sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from measure.serp_snapshots s
    where s.site_id = ${siteId} and s.fetched_at >= now() - interval '7 days' and s.provider <> 'openrouter'`;
  return row?.n ?? 0;
}

/** The site's 28-day click total over the page and the query reports, which count the same clicks twice. */
export async function legacyGscClicks28d(siteId: string, sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select coalesce(sum((metrics->>'clicks')::numeric), 0)::float as n from measure.external_metrics
    where site_id = ${siteId} and surface in ('gsc_page', 'gsc_query') and date >= current_date - 28`;
  return row?.n ?? 0;
}

/**
 * Per-asset GA4 sessions and Search Console clicks summed over published
 * assets, as the old join found them: on `dimension->>'path'`, which no
 * connector writes. The old join also accepted `content_id`, but nothing set
 * it on these rows then; now resolveMetricContentIds does, so it is left out
 * here to reproduce what the page showed.
 */
export async function legacyAssetTotals(siteId: string, sql: postgres.Sql): Promise<{ ai_sessions_30d: number; gsc_clicks_28d: number }> {
  const [row] = await sql<{ ai_sessions_30d: number; gsc_clicks_28d: number }[]>`
    with items as (
      select p.path from content.content_items ci
      join content.published_pages p on p.content_item_id = ci.id and p.site_id = ci.site_id
      where ci.site_id = ${siteId} and ci.status = 'published'
    )
    select
      coalesce((select sum((m.metrics->>'sessions')::numeric) from measure.external_metrics m join items i on m.dimension->>'path' = i.path
        where m.site_id = ${siteId} and m.surface = 'ga4_referral' and m.date >= current_date - 30), 0)::float as ai_sessions_30d,
      coalesce((select sum((m.metrics->>'clicks')::numeric) from measure.external_metrics m join items i on m.dimension->>'path' = i.path
        where m.site_id = ${siteId} and m.surface = 'gsc_page' and m.date >= current_date - 28), 0)::float as gsc_clicks_28d`;
  return row ?? { ai_sessions_30d: 0, gsc_clicks_28d: 0 };
}

/**
 * Posts in the Refresh inventory cited natively in the last 30 days, as the
 * refresh scan counted them: an owned URL on any surface of one of our own
 * snapshots, so an organic ranking counted as a citation.
 */
export async function legacyRefreshCitedPosts(siteId: string, sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    with cites as (
      select distinct content.url_key(c.url) as key
      from measure.serp_citations c join measure.serp_snapshots s on s.id = c.serp_snapshot_id
      where c.site_id = ${siteId} and c.is_owned and s.provider in ('dataforseo', 'serpapi') and s.fetched_at >= now() - interval '30 days'
    )
    select count(*)::int as n from content.cms_items i join cites c on c.key = i.url_key where i.site_id = ${siteId}`;
  return row?.n ?? 0;
}
