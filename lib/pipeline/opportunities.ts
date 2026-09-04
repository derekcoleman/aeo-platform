import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { citationGaps, type CitationGap } from "@/lib/demand/store";

/**
 * The ranked queue. `score_breakdown` is stored next to `score` so a number
 * is arguable rather than magic, and `dedupe_key` stops the nightly scan
 * reopening the same gap.
 */

export interface ScoreInputs {
  /** 0–100; measured demand (autocomplete/PAA frequency, GSC impressions). */
  demand: number;
  /** 0–100; an AIO triggers, a competitor is cited, we are not. */
  citationGap: number;
  /** 0–100; entity overlap with the brand brain. Defaults to neutral until the brain exists. */
  brandFit?: number;
  /** 0–100; commercial intent / proximity to money pages. */
  businessValue?: number;
  /** 0–100; how contested the SERP is. */
  difficulty?: number;
  /** 0–100; a signal that makes this timely. */
  freshness?: number;
}

export const SCORE_WEIGHTS = { demand: 0.3, citationGap: 0.3, brandFit: 0.15, businessValue: 0.15, difficulty: 0.15, freshness: 0.1 } as const;

export interface Scored {
  score: number;
  breakdown: Record<keyof typeof SCORE_WEIGHTS, { value: number; weight: number; contribution: number }>;
}

const clamp = (n: number | undefined, fallback: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? (n as number) : fallback));

export function scoreOpportunity(i: ScoreInputs): Scored {
  const values = {
    demand: clamp(i.demand, 0),
    citationGap: clamp(i.citationGap, 0),
    brandFit: clamp(i.brandFit, 50),
    businessValue: clamp(i.businessValue, 50),
    difficulty: clamp(i.difficulty, 50),
    freshness: clamp(i.freshness, 0),
  };
  const breakdown = {} as Scored["breakdown"];
  let score = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof typeof SCORE_WEIGHTS)[]) {
    const weight = SCORE_WEIGHTS[key];
    const sign = key === "difficulty" ? -1 : 1;
    const contribution = Math.round(sign * values[key] * weight * 100) / 100;
    breakdown[key] = { value: values[key], weight: sign * weight, contribution };
    score += contribution;
  }
  return { score: Math.round(Math.max(0, score) * 100) / 100, breakdown };
}

export interface OpportunityInput {
  source: "citation_gap" | "question_graph" | "signal" | "gsc" | "manual" | "refresh";
  title: string;
  targetQuery: string;
  questionId?: string | null;
  contentItemId?: string | null;
  /** The context.signals row that raised this, for lineage back to the evidence. */
  signalId?: string | null;
  topicId?: string | null;
  /** Preferred article format, from the topic or a manual request. */
  format?: "comparison" | "howto" | "guide" | "listicle" | "faq" | null;
  score: number;
  scoreBreakdown: Record<string, unknown>;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

export interface TopicWeight {
  id: string;
  priority: number;
  formats: string[];
  status: "active" | "paused" | "archived";
}

/**
 * Citation gaps → opportunities. The gap is the strongest signal we have, so
 * it dominates. A topic's priority moves business value (5 = 100, 1 = 20);
 * a paused topic contributes nothing new; the topic's first preferred format
 * becomes the brief's format hint.
 */
export function opportunitiesFromCitationGaps(gaps: CitationGap[], topics: Map<string, TopicWeight> = new Map()): OpportunityInput[] {
  const out: OpportunityInput[] = [];
  for (const g of gaps) {
    const topic = g.topic_id ? topics.get(g.topic_id) : undefined;
    if (topic && topic.status !== "active") continue;
    const competitors = g.competitor_domains.length;
    const scored = scoreOpportunity({
      demand: g.demand_score,
      citationGap: Math.min(100, 60 + competitors * 10),
      difficulty: Math.min(100, 30 + competitors * 8),
      businessValue: topic ? topic.priority * 20 : undefined,
    });
    out.push({
      source: "citation_gap",
      title: g.text,
      targetQuery: g.text,
      questionId: g.question_id,
      topicId: g.topic_id ?? null,
      format: (topic?.formats[0] as OpportunityInput["format"]) ?? null,
      score: scored.score,
      scoreBreakdown: scored.breakdown,
      evidence: { snapshotId: g.snapshot_id, provider: g.provider, competitorDomains: g.competitor_domains, fetchedAt: g.fetched_at, topicId: g.topic_id ?? null },
      dedupeKey: `question:${g.question_id}`,
    });
  }
  return out;
}

export interface UpsertSummary {
  inserted: number;
  updated: number;
}

/** Insert new opportunities; re-score open ones; never touch queued/in-progress/published/dismissed rows. */
export async function upsertOpportunities(siteId: string, rows: OpportunityInput[], sql: postgres.Sql = appDb()): Promise<UpsertSummary> {
  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into content.opportunities (site_id, source, title, target_query, question_id, content_item_id, signal_id, topic_id, format, score, score_breakdown, evidence, dedupe_key)
      values (${siteId}, ${r.source}, ${r.title}, ${r.targetQuery}, ${r.questionId ?? null}, ${r.contentItemId ?? null}, ${r.signalId ?? null}, ${r.topicId ?? null}, ${r.format ?? null},
              ${r.score}, ${sql.json(r.scoreBreakdown as never)}, ${sql.json(r.evidence as never)}, ${r.dedupeKey})
      on conflict (site_id, dedupe_key) do update
        set score = excluded.score, score_breakdown = excluded.score_breakdown, evidence = excluded.evidence,
            signal_id = coalesce(excluded.signal_id, content.opportunities.signal_id),
            topic_id = coalesce(excluded.topic_id, content.opportunities.topic_id),
            format = coalesce(content.opportunities.format, excluded.format), updated_at = now()
        where content.opportunities.status = 'open'
      returning (xmax = 0) as inserted`;
    if (!row) continue;
    if (row.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

export async function loadTopicWeights(siteId: string, sql: postgres.Sql = appDb()): Promise<Map<string, TopicWeight>> {
  const rows = await sql<TopicWeight[]>`select id, priority, formats, status from measure.topics where site_id = ${siteId}`;
  return new Map(rows.map((t) => [t.id, t]));
}

export async function scanSite(siteId: string, sql: postgres.Sql = appDb(), limit = 100): Promise<UpsertSummary & { gaps: number }> {
  const [gaps, topics] = await Promise.all([citationGaps(siteId, limit, sql), loadTopicWeights(siteId, sql)]);
  const summary = await upsertOpportunities(siteId, opportunitiesFromCitationGaps(gaps, topics), sql);
  return { ...summary, gaps: gaps.length };
}

export interface ManualOpportunityInput {
  title: string;
  targetQuery?: string | null;
  questionId?: string | null;
  topicId?: string | null;
  format?: OpportunityInput["format"];
  note?: string | null;
}

/** "Write about this": a hand-made opportunity that outranks everything scanned, tied to its topic and format. */
export async function createManualOpportunity(siteId: string, input: ManualOpportunityInput, sql: postgres.Sql = appDb()): Promise<{ id: string }> {
  const title = input.title.trim();
  const dedupeKey = input.questionId ? `question:${input.questionId}` : `manual:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;
  const scored = scoreOpportunity({ demand: 70, citationGap: 70, businessValue: 90, difficulty: 40, freshness: 60 });
  const [row] = await sql<{ id: string }[]>`
    insert into content.opportunities (site_id, source, title, target_query, question_id, topic_id, format, score, score_breakdown, evidence, dedupe_key)
    values (${siteId}, 'manual', ${title}, ${(input.targetQuery ?? title).trim()}, ${input.questionId ?? null}, ${input.topicId ?? null}, ${input.format ?? null},
            ${scored.score}, ${sql.json(scored.breakdown as never)}, ${sql.json({ manual: true, note: input.note ?? null } as never)}, ${dedupeKey})
    on conflict (site_id, dedupe_key) do update
      set status = case when content.opportunities.status in ('dismissed', 'failed', 'published') then 'open' else content.opportunities.status end,
          title = excluded.title, topic_id = coalesce(excluded.topic_id, content.opportunities.topic_id), format = coalesce(excluded.format, content.opportunities.format),
          score = greatest(content.opportunities.score, excluded.score), evidence = excluded.evidence, updated_at = now()
    returning id`;
  if (!row) throw new Error("opportunity insert returned no row");
  return row;
}

export interface OpportunityRow {
  id: string;
  org_id: string;
  site_id: string;
  source: OpportunityInput["source"];
  status: "open" | "queued" | "in_progress" | "published" | "dismissed" | "failed";
  title: string;
  target_query: string;
  question_id: string | null;
  content_item_id: string | null;
  topic_id: string | null;
  format: OpportunityInput["format"];
  score: number;
  evidence: Record<string, unknown>;
}

export async function loadOpportunity(id: string, sql: postgres.Sql = appDb()): Promise<OpportunityRow | null> {
  const [row] = await sql<OpportunityRow[]>`
    select id, org_id, site_id, source, status, title, target_query, question_id, content_item_id, topic_id, format, score::float as score, evidence
    from content.opportunities where id = ${id}`;
  return row ?? null;
}

export async function markOpportunity(id: string, status: OpportunityRow["status"], sql: postgres.Sql = appDb(), reason?: string): Promise<void> {
  await sql`update content.opportunities set status = ${status}, dismissed_reason = coalesce(${reason ?? null}, dismissed_reason), updated_at = now() where id = ${id}`;
}

/** Open a refresh opportunity for an asset that did not earn its citation. Idempotent per (item, window). */
export async function openRefreshOpportunity(
  input: { siteId: string; contentItemId: string; questionId: string | null; title: string; targetQuery: string; windowDays: number; evidence: Record<string, unknown> },
  sql: postgres.Sql = appDb(),
): Promise<UpsertSummary> {
  const scored = scoreOpportunity({ demand: 50, citationGap: 70, freshness: 60 });
  return upsertOpportunities(
    input.siteId,
    [
      {
        source: "refresh",
        title: `Refresh: ${input.title}`,
        targetQuery: input.targetQuery,
        questionId: input.questionId,
        contentItemId: input.contentItemId,
        score: scored.score,
        scoreBreakdown: scored.breakdown,
        evidence: input.evidence,
        dedupeKey: `refresh:${input.contentItemId}:${input.windowDays}d`,
      },
    ],
    sql,
  );
}
