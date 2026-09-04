import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Read models for the Strategy page. Native numbers come from our own SERP
 * snapshots; Profound numbers come from measure.external_metrics rows the
 * connector wrote, and are always labelled as Profound's.
 */

export interface PromptRow {
  id: string;
  text: string;
  source: string;
  topic_id: string | null;
  pinned: boolean;
  excluded: boolean;
  is_tracked: boolean;
  tracking_tier: "daily" | "weekly" | "monthly" | "none";
  demand_score: number;
  aio_triggered: boolean | null;
  aio_owned: boolean;
  competitor_domains: string[];
  profound_mention_rate: number | null;
  profound_visibility: number | null;
}

export async function listPrompts(siteId: string, opts: { topicId?: string | null; limit?: number } = {}, sql: postgres.Sql = appDb()): Promise<PromptRow[]> {
  return sql<PromptRow[]>`
    select q.id, q.text, q.source, q.topic_id, q.pinned, q.excluded, q.is_tracked, q.tracking_tier, q.demand_score::float as demand_score,
           s.aio_triggered,
           coalesce((select bool_or(c.is_owned) from measure.serp_citations c where c.serp_snapshot_id = s.id and c.surface = 'ai_overview'), false) as aio_owned,
           coalesce((select array_agg(distinct c.domain order by c.domain) from measure.serp_citations c where c.serp_snapshot_id = s.id and c.surface = 'ai_overview' and not c.is_owned), '{}') as competitor_domains,
           (select avg((m.metrics->>'brand_mentioned')::numeric)::float from measure.external_metrics m where m.question_id = q.id and m.surface = 'profound_visibility' and m.date >= current_date - 30) as profound_mention_rate,
           (select avg((m.metrics->>'visibility')::numeric)::float from measure.external_metrics m where m.question_id = q.id and m.surface = 'profound_visibility' and m.date >= current_date - 30) as profound_visibility
    from measure.questions q
    left join lateral (
      select ss.id, ss.aio_triggered from measure.serp_snapshots ss
      where ss.question_id = q.id and ss.provider in ('dataforseo', 'serpapi') order by ss.fetched_at desc limit 1
    ) s on true
    where q.site_id = ${siteId} and (${opts.topicId ?? null}::uuid is null or q.topic_id = ${opts.topicId ?? null}::uuid)
    order by q.pinned desc, q.excluded asc, q.is_tracked desc, q.demand_score desc
    limit ${opts.limit ?? 200}`;
}

export interface ProfoundEngineRow {
  engine: string;
  prompts: number;
  answers: number;
  mention_rate: number | null;
  visibility: number | null;
  owned_citation_rate: number | null;
}

/** Profound, by platform, last 30 days. Empty when the connector is off or has not synced. */
export async function profoundByEngine(siteId: string, sql: postgres.Sql = appDb()): Promise<ProfoundEngineRow[]> {
  return sql<ProfoundEngineRow[]>`
    select m.dimension->>'engine' as engine,
           count(distinct m.question_id)::int as prompts,
           count(*)::int as answers,
           avg((m.metrics->>'brand_mentioned')::numeric)::float as mention_rate,
           avg((m.metrics->>'visibility')::numeric)::float as visibility,
           avg(case when (m.metrics->>'citations')::numeric > 0 then ((m.metrics->>'owned_citations')::numeric > 0)::int end)::float as owned_citation_rate
    from measure.external_metrics m
    where m.site_id = ${siteId} and m.surface = 'profound_visibility' and m.date >= current_date - 30
    group by m.dimension->>'engine' order by answers desc`;
}

export interface ProfoundTopicRow {
  topic_id: string | null;
  prompts: number;
  mention_rate: number | null;
  visibility: number | null;
}

export async function profoundByTopic(siteId: string, sql: postgres.Sql = appDb()): Promise<Map<string, ProfoundTopicRow>> {
  const rows = await sql<ProfoundTopicRow[]>`
    select q.topic_id, count(distinct q.id)::int as prompts,
           avg((m.metrics->>'brand_mentioned')::numeric)::float as mention_rate,
           avg((m.metrics->>'visibility')::numeric)::float as visibility
    from measure.external_metrics m join measure.questions q on q.id = m.question_id
    where m.site_id = ${siteId} and m.surface = 'profound_visibility' and m.date >= current_date - 30
    group by q.topic_id`;
  return new Map(rows.map((r) => [r.topic_id ?? "", r]));
}

export interface CompetitorDomainRow {
  domain: string;
  citations: number;
  questions: number;
  providers: string[];
}

/** Who gets cited instead of us, last 30 days, native and Profound sources labelled. */
export async function competitorDomains(siteId: string, opts: { topicId?: string | null; limit?: number } = {}, sql: postgres.Sql = appDb()): Promise<CompetitorDomainRow[]> {
  return sql<CompetitorDomainRow[]>`
    select c.domain, count(*)::int as citations, count(distinct s.question_id)::int as questions,
           array_agg(distinct s.provider::text order by s.provider::text) as providers
    from measure.serp_citations c
    join measure.serp_snapshots s on s.id = c.serp_snapshot_id
    join measure.questions q on q.id = s.question_id
    where c.site_id = ${siteId} and not c.is_owned and c.surface = 'ai_overview' and s.fetched_at >= now() - interval '30 days'
      and not q.excluded and (${opts.topicId ?? null}::uuid is null or q.topic_id = ${opts.topicId ?? null}::uuid)
    group by c.domain order by citations desc limit ${opts.limit ?? 15}`;
}

export interface ProfoundConnectionSummary {
  id: string;
  status: string;
  mode: string;
  category: string | null;
  last_synced_at: string | Date | null;
  last_error: string | null;
}

export async function profoundConnection(siteId: string, orgId: string, sql: postgres.Sql = appDb()): Promise<ProfoundConnectionSummary | null> {
  const [row] = await sql<ProfoundConnectionSummary[]>`
    select id, status, coalesce(config->>'mode', 'csv') as mode, coalesce(config->>'categoryName', external_account_name) as category, last_synced_at, last_error
    from context.context_connections
    where org_id = ${orgId} and provider = 'profound' and (site_id = ${siteId} or site_id is null) and status <> 'disconnected'
    order by (site_id = ${siteId}) desc, created_at desc limit 1`;
  return row ?? null;
}
