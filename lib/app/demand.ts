import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { trackableByDemand } from "@/lib/demand/store";

/**
 * Read models for the Demand page: the question graph with each question's
 * latest native SERP snapshot (measure.v_native_aio), tracking tiers, and
 * this month's SERP spend against the org's budget. Profound-sourced
 * snapshots and answer probes are excluded here; they are labelled as theirs
 * where shown.
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
      select ss.id, ss.fetched_at, ss.aio_triggered from measure.v_native_aio ss
      where ss.question_id = q.id order by ss.fetched_at desc limit 1
    ) s on true
    where q.site_id = ${siteId} and (${!opts.trackedOnly}::boolean or q.is_tracked)
    order by q.is_tracked desc, q.demand_score desc, q.seen_count desc
    limit ${limit}`;
}

/** Demand lists at most this many citation gaps, and the tab's badge counts the list. */
export const DEMAND_GAP_LIMIT = 30;

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
           (select count(*)::int from measure.v_native_aio s
             where s.site_id = ${siteId} and s.fetched_at >= now() - interval '7 days') as snapshots_7d
    from measure.questions where site_id = ${siteId}`;
  return row ?? { questions: 0, tracked: 0, daily: 0, weekly: 0, monthly: 0, snapshots_7d: 0 };
}

export interface SerpSpendSummary {
  site_month_usd: number;
  /** The org's SERP spend this month as the spend governor counts it (the ledger before its first call). */
  org_month_usd: number;
  /** Held by calls in flight; counts against the budget until they settle. */
  reserved_usd: number;
  budget_usd: number;
  calls_month: number;
  cached_month: number;
}

/**
 * This month's SERP spend against the org's budget. Spent, held and the cap
 * come from the governor's counter (ops.spend_counters), which is what
 * refuses the next call; the site's share and the call counts from the
 * ledger. Months are UTC, as the governor's are.
 */
export async function serpSpendSummary(orgId: string, siteId: string, sql: postgres.Sql = appDb()): Promise<SerpSpendSummary> {
  const [row] = await sql<SerpSpendSummary[]>`
    with m as (select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as since,
                      date_trunc('month', now() at time zone 'utc')::date as period_start)
    select coalesce((select sum(cost_usd) from measure.serp_spend where site_id = ${siteId} and not cached and at >= m.since), 0)::float as site_month_usd,
           coalesce(c.spent_usd, (select sum(cost_usd) from measure.serp_spend where org_id = ${orgId} and not cached and at >= m.since), 0)::float as org_month_usd,
           coalesce(c.reserved_usd, 0)::float as reserved_usd,
           coalesce(b.cap_usd, o.serp_monthly_budget_usd)::float as budget_usd,
           (select count(*)::int from measure.serp_spend where site_id = ${siteId} and at >= m.since) as calls_month,
           (select count(*)::int from measure.serp_spend where site_id = ${siteId} and cached and at >= m.since) as cached_month
    from app.organizations o
    cross join m
    left join ops.budgets b on b.org_id = o.id and b.site_id is null and b.resource = 'serp' and b.period = 'month'
    left join ops.spend_counters c on c.budget_id = b.id and c.period_start = m.period_start
    where o.id = ${orgId}`;
  return row ?? { site_month_usd: 0, org_month_usd: 0, reserved_usd: 0, budget_usd: 0, calls_month: 0, cached_month: 0 };
}

export async function setQuestionTracking(siteId: string, questionId: string, tier: QuestionRow["tracking_tier"], sql: postgres.Sql = appDb()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update measure.questions set is_tracked = ${tier !== "none"}, tracking_tier = ${tier}
    where id = ${questionId} and site_id = ${siteId} returning id`;
  return rows.length > 0;
}

/**
 * Track the top N by demand on a tier; anything already on a faster tier
 * keeps it. Excluded questions, and keywords only the competitor gap brought
 * in, are never picked (trackableByDemand).
 */
export async function trackTopQuestions(siteId: string, n: number, tier: Exclude<QuestionRow["tracking_tier"], "none">, sql: postgres.Sql = appDb()): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    with top as (select id from measure.questions where site_id = ${siteId} and ${trackableByDemand(sql)} order by demand_score desc, seen_count desc limit ${n})
    update measure.questions q set is_tracked = true,
      tracking_tier = case when q.tracking_tier = 'daily' or (q.tracking_tier = 'weekly' and ${tier} = 'monthly') then q.tracking_tier else ${tier}::measure.tracking_tier end
    from top where q.id = top.id returning q.id`;
  return rows.length;
}

export async function trackedQuestionIds(siteId: string, limit = 200, sql: postgres.Sql = appDb()): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from measure.questions where site_id = ${siteId} and is_tracked and not excluded order by demand_score desc limit ${limit}`;
  return rows.map((r) => r.id);
}
