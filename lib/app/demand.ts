import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Read models for the Demand page: the question graph with each question's
 * latest native SERP snapshot, tracking tiers, and this month's SERP spend
 * against the org's budget. Profound-sourced snapshots are excluded here;
 * they are enrichment and are labelled as such where shown.
 */

export interface QuestionRow {
  id: string;
  text: string;
  source: string;
  demand_score: number;
  is_tracked: boolean;
  tracking_tier: "daily" | "weekly" | "monthly" | "none";
  seen_count: number;
  last_seen_at: string | Date;
  last_snapshot_at: string | Date | null;
  aio_triggered: boolean | null;
  aio_owned: boolean;
  competitor_count: number;
}

export async function listSiteQuestions(siteId: string, opts: { trackedOnly?: boolean; limit?: number } = {}, sql: postgres.Sql = appDb()): Promise<QuestionRow[]> {
  const limit = opts.limit ?? 100;
  return sql<QuestionRow[]>`
    select q.id, q.text, q.source, q.demand_score::float as demand_score, q.is_tracked, q.tracking_tier, q.seen_count, q.last_seen_at,
           s.fetched_at as last_snapshot_at, s.aio_triggered,
           coalesce((select bool_or(c.is_owned) from measure.serp_citations c where c.serp_snapshot_id = s.id and c.surface = 'ai_overview'), false) as aio_owned,
           coalesce((select count(distinct c.domain)::int from measure.serp_citations c where c.serp_snapshot_id = s.id and c.surface = 'ai_overview' and not c.is_owned), 0) as competitor_count
    from measure.questions q
    left join lateral (
      select ss.id, ss.fetched_at, ss.aio_triggered from measure.serp_snapshots ss
      where ss.question_id = q.id and ss.provider in ('dataforseo', 'serpapi') order by ss.fetched_at desc limit 1
    ) s on true
    where q.site_id = ${siteId} and (${!opts.trackedOnly}::boolean or q.is_tracked)
    order by q.is_tracked desc, q.demand_score desc, q.seen_count desc
    limit ${limit}`;
}

export interface DemandCounts {
  questions: number;
  tracked: number;
  daily: number;
  weekly: number;
  monthly: number;
  snapshots_7d: number;
}

export async function demandCounts(siteId: string, sql: postgres.Sql = appDb()): Promise<DemandCounts> {
  const [row] = await sql<DemandCounts[]>`
    select count(*)::int as questions,
           count(*) filter (where is_tracked)::int as tracked,
           count(*) filter (where is_tracked and tracking_tier = 'daily')::int as daily,
           count(*) filter (where is_tracked and tracking_tier = 'weekly')::int as weekly,
           count(*) filter (where is_tracked and tracking_tier = 'monthly')::int as monthly,
           (select count(*)::int from measure.serp_snapshots s where s.site_id = ${siteId} and s.fetched_at >= now() - interval '7 days') as snapshots_7d
    from measure.questions where site_id = ${siteId}`;
  return row ?? { questions: 0, tracked: 0, daily: 0, weekly: 0, monthly: 0, snapshots_7d: 0 };
}

export interface SerpSpendSummary {
  site_month_usd: number;
  org_month_usd: number;
  budget_usd: number;
  calls_month: number;
  cached_month: number;
}

export async function serpSpendSummary(orgId: string, siteId: string, sql: postgres.Sql = appDb()): Promise<SerpSpendSummary> {
  const [row] = await sql<SerpSpendSummary[]>`
    select coalesce((select sum(cost_usd) from measure.serp_spend where site_id = ${siteId} and not cached and at >= date_trunc('month', now())), 0)::float as site_month_usd,
           coalesce((select sum(cost_usd) from measure.serp_spend where org_id = ${orgId} and not cached and at >= date_trunc('month', now())), 0)::float as org_month_usd,
           (select serp_monthly_budget_usd::float from app.organizations where id = ${orgId}) as budget_usd,
           (select count(*)::int from measure.serp_spend where site_id = ${siteId} and at >= date_trunc('month', now())) as calls_month,
           (select count(*)::int from measure.serp_spend where site_id = ${siteId} and cached and at >= date_trunc('month', now())) as cached_month`;
  return row ?? { site_month_usd: 0, org_month_usd: 0, budget_usd: 0, calls_month: 0, cached_month: 0 };
}

export async function setQuestionTracking(siteId: string, questionId: string, tier: QuestionRow["tracking_tier"], sql: postgres.Sql = appDb()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update measure.questions set is_tracked = ${tier !== "none"}, tracking_tier = ${tier}
    where id = ${questionId} and site_id = ${siteId} returning id`;
  return rows.length > 0;
}

/** Track the top N by demand on a tier; anything already on a faster tier keeps it. */
export async function trackTopQuestions(siteId: string, n: number, tier: Exclude<QuestionRow["tracking_tier"], "none">, sql: postgres.Sql = appDb()): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    with top as (select id from measure.questions where site_id = ${siteId} order by demand_score desc, seen_count desc limit ${n})
    update measure.questions q set is_tracked = true,
      tracking_tier = case when q.tracking_tier = 'daily' or (q.tracking_tier = 'weekly' and ${tier} = 'monthly') then q.tracking_tier else ${tier}::measure.tracking_tier end
    from top where q.id = top.id returning q.id`;
  return rows.length;
}

export async function trackedQuestionIds(siteId: string, limit = 200, sql: postgres.Sql = appDb()): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from measure.questions where site_id = ${siteId} and is_tracked order by demand_score desc limit ${limit}`;
  return rows.map((r) => r.id);
}
