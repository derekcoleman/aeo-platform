import type postgres from "postgres";
import { cosine, defaultEmbedder, EMBEDDING_DIMENSIONS, vectorLiteral, type Embedder } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import { scoreOpportunity, upsertOpportunities, type OpportunityInput } from "@/lib/pipeline/opportunities";
import { listEntities } from "./entities";
import type { SignalKind } from "./types";

/**
 * Newsworthiness detection, deterministic half. Every detector reads what
 * the connectors already landed (chunks, questions, citations) and writes
 * context.signals; a signal is deduped against the last 90 days by
 * embedding cosine > 0.9 and scored on relevance × recency × evidence
 * strength × content gap. The daily LLM pass and the weekly digest are the
 * later slice; in v1 only unanswered questions bridge into opportunities,
 * because they alone carry a target query the pipeline can act on.
 */

export interface DetectedSignal {
  kind: SignalKind;
  title: string;
  /** Text used for dedupe embedding; stable across runs for the same finding. */
  dedupeText: string;
  evidence: Record<string, unknown>;
  score: number;
  questionId?: string | null;
}

export const TERM_SPIKE_MIN_N7 = 5;
export const TERM_SPIKE_MIN_Z = 3;
export const UNANSWERED_MIN_SEEN = 3;
export const SIGNAL_DEDUPE_COSINE = 0.9;
export const SIGNAL_DEDUPE_DAYS = 90;

/** z-score of the last-7-day count against the 30-day Poisson expectation. */
export function poissonZ(n7: number, n30: number): number {
  const expected = (n30 * 7) / 30;
  return (n7 - expected) / Math.sqrt(Math.max(expected, 1));
}

const STOP = new Set(["thing", "today", "thank", "think", "peopl", "someth", "anyth", "everyon", "realli", "actual", "pleas", "week", "look", "know", "need", "want", "work", "time", "make", "good"]);

/**
 * Terms whose 7-day frequency across the org's chunks spikes against the
 * 30-day baseline. Reads the stored tsvector lexemes, so the terms are the
 * same stems FTS matches on and a spike is retrievable by the same query.
 */
export async function detectTermSpikes(orgId: string, siteId: string | null, sql: postgres.Sql = appDb(), asOf: Date = new Date()): Promise<DetectedSignal[]> {
  const rows = await sql<{ term: string; n7: number; n30: number }[]>`
    with recent as (
      select c.tsv, d.source_ts from context.context_chunks c join context.context_documents d on d.id = c.document_id
      where c.org_id = ${orgId} and (d.site_id is null or d.site_id = ${siteId})
        and d.source_ts >= ${asOf}::timestamptz - interval '30 days' and d.source_ts <= ${asOf}::timestamptz
    ),
    terms as (
      select t.term, (r.source_ts >= ${asOf}::timestamptz - interval '7 days') as in7
      from recent r, unnest(tsvector_to_array(r.tsv)) as t(term)
      where length(t.term) >= 4 and t.term !~ '^[0-9]'
    )
    select term, count(*) filter (where in7)::int as n7, count(*)::int as n30
    from terms group by term having count(*) filter (where in7) >= ${TERM_SPIKE_MIN_N7}
    order by n7 desc limit 500`;
  const out: DetectedSignal[] = [];
  for (const r of rows) {
    if (STOP.has(r.term)) continue;
    const z = poissonZ(r.n7, r.n30);
    if (z < TERM_SPIKE_MIN_Z) continue;
    out.push({
      kind: "term_spike",
      title: `"${r.term}" is spiking in internal conversation`,
      dedupeText: `term spike ${r.term}`,
      evidence: { term: r.term, n7: r.n7, n30: r.n30, z: Math.round(z * 100) / 100 },
      score: Math.min(100, Math.round(20 + z * 10 + r.n7)),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 20);
}

/** Buyer questions seen repeatedly with no published or in-flight answer on the site. */
export async function detectUnansweredQuestions(orgId: string, siteId: string, sql: postgres.Sql = appDb(), limit = 25): Promise<DetectedSignal[]> {
  const rows = await sql<{ id: string; text: string; seen_count: number; demand_score: number; source: string }[]>`
    select q.id, q.text, q.seen_count, q.demand_score::float as demand_score, q.source::text as source
    from measure.questions q
    where q.org_id = ${orgId} and q.site_id = ${siteId} and q.seen_count >= ${UNANSWERED_MIN_SEEN}
      and not exists (
        select 1 from content.opportunities o
        where o.site_id = q.site_id and o.question_id = q.id and o.status in ('queued', 'in_progress', 'published')
      )
    order by q.seen_count desc, q.demand_score desc limit ${limit}`;
  return rows.map((r) => ({
    kind: "unanswered_question" as const,
    title: r.text,
    dedupeText: `unanswered question ${r.text}`,
    evidence: { questionId: r.id, seenCount: r.seen_count, demandScore: r.demand_score, source: r.source },
    score: Math.min(100, Math.round(r.demand_score * 0.5 + r.seen_count * 5)),
    questionId: r.id,
  }));
}

/** Competitor entities mentioned more in the last 7 days than the 30-day baseline predicts (FTS on the alias, never substring). */
export async function detectCompetitorSpikes(orgId: string, siteId: string | null, sql: postgres.Sql = appDb(), asOf: Date = new Date()): Promise<DetectedSignal[]> {
  const competitors = await listEntities(orgId, sql, ["competitor"]);
  const out: DetectedSignal[] = [];
  for (const c of competitors) {
    const terms = [c.name, ...c.aliases].filter((a) => a.trim().length >= 2);
    if (terms.length === 0) continue;
    const query = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    const [row] = await sql<{ n7: number; n30: number }[]>`
      select count(*) filter (where d.source_ts >= ${asOf}::timestamptz - interval '7 days')::int as n7, count(*)::int as n30
      from context.context_chunks ch join context.context_documents d on d.id = ch.document_id
      where ch.org_id = ${orgId} and (d.site_id is null or d.site_id = ${siteId})
        and d.source_ts >= ${asOf}::timestamptz - interval '30 days' and d.source_ts <= ${asOf}::timestamptz
        and ch.tsv @@ websearch_to_tsquery('english', ${query})`;
    if (!row || row.n7 < TERM_SPIKE_MIN_N7) continue;
    const z = poissonZ(row.n7, row.n30);
    if (z < TERM_SPIKE_MIN_Z) continue;
    out.push({
      kind: "competitor_spike",
      title: `${c.name} is coming up more often internally`,
      dedupeText: `competitor spike ${c.name}`,
      evidence: { entityId: c.id, name: c.name, n7: row.n7, n30: row.n30, z: Math.round(z * 100) / 100 },
      score: Math.min(100, Math.round(30 + z * 10 + row.n7)),
    });
  }
  return out;
}

export interface SignalUpsertSummary {
  inserted: number;
  merged: number;
}

interface ExistingSignal {
  id: string;
  kind: SignalKind;
  embedding: string | null;
}

function parseVector(s: string | null): number[] | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as number[];
  } catch {
    return null;
  }
}

/** Insert new signals; a finding within cosine 0.9 of a same-kind signal from the last 90 days bumps that row instead. */
export async function upsertSignals(
  orgId: string,
  siteId: string | null,
  found: DetectedSignal[],
  opts: { embedder?: Embedder; sql?: postgres.Sql; now?: Date } = {},
): Promise<SignalUpsertSummary> {
  const sql = opts.sql ?? appDb();
  const embedder = opts.embedder ?? defaultEmbedder();
  const now = opts.now ?? new Date();
  const summary: SignalUpsertSummary = { inserted: 0, merged: 0 };
  if (found.length === 0) return summary;
  const canEmbed = embedder.dimensions === EMBEDDING_DIMENSIONS;
  let vectors: number[][] = [];
  if (canEmbed) {
    try {
      vectors = await embedder.embed(found.map((f) => f.dedupeText));
    } catch {
      vectors = [];
    }
  }
  const existing = await sql<ExistingSignal[]>`
    select id, kind, dedupe_embedding::text as embedding from context.signals
    where org_id = ${orgId} and site_id is not distinct from ${siteId} and status <> 'dismissed'
      and last_seen_at >= ${now}::timestamptz - interval '90 days'`;
  const parsed = existing.map((e) => ({ ...e, vec: parseVector(e.embedding) }));
  for (let i = 0; i < found.length; i++) {
    const f = found[i]!;
    const v = vectors[i] ?? null;
    const dup = v ? parsed.find((e) => e.kind === f.kind && e.vec && cosine(e.vec, v) > SIGNAL_DEDUPE_COSINE) : null;
    if (dup) {
      await sql`
        update context.signals set seen_count = seen_count + 1, last_seen_at = ${now}, score = greatest(score, ${f.score}), evidence = ${sql.json(f.evidence as never)}
        where id = ${dup.id} and org_id = ${orgId}`;
      summary.merged++;
      continue;
    }
    const [row] = await sql<{ id: string }[]>`
      insert into context.signals (org_id, site_id, kind, title, evidence, score, dedupe_embedding, embedding_model, first_seen_at, last_seen_at)
      values (${orgId}, ${siteId}, ${f.kind}, ${f.title}, ${sql.json(f.evidence as never)}, ${f.score},
              ${v ? vectorLiteral(v) : null}, ${v ? embedder.id : null}, ${now}, ${now})
      returning id`;
    if (row && v) parsed.push({ id: row.id, kind: f.kind, embedding: null, vec: v });
    summary.inserted++;
  }
  return summary;
}

/** Unanswered questions → opportunities (source 'signal'); other kinds wait for the digest. */
export async function bridgeSignalsToOpportunities(orgId: string, siteId: string, sql: postgres.Sql = appDb()): Promise<{ bridged: number }> {
  const rows = await sql<{ id: string; title: string; score: number; evidence: Record<string, unknown> }[]>`
    select id, title, score::float as score, evidence from context.signals
    where org_id = ${orgId} and site_id = ${siteId} and kind = 'unanswered_question' and status = 'new'
    order by score desc limit 50`;
  const inputs: OpportunityInput[] = [];
  for (const s of rows) {
    const questionId = typeof s.evidence.questionId === "string" ? s.evidence.questionId : null;
    if (!questionId) continue;
    const demand = typeof s.evidence.demandScore === "number" ? s.evidence.demandScore : 0;
    const scored = scoreOpportunity({ demand, citationGap: 40, freshness: Math.min(100, s.score) });
    inputs.push({
      source: "signal",
      title: s.title,
      targetQuery: s.title,
      questionId,
      signalId: s.id,
      score: scored.score,
      scoreBreakdown: scored.breakdown,
      evidence: { signalId: s.id, ...s.evidence },
      dedupeKey: `question:${questionId}`,
    });
  }
  if (inputs.length === 0) return { bridged: 0 };
  await upsertOpportunities(siteId, inputs, sql);
  await sql`update context.signals set status = 'bridged' where org_id = ${orgId} and id = any(${sql.array(rows.map((r) => r.id))}::uuid[])`;
  return { bridged: inputs.length };
}

export interface SignalScanSummary {
  detected: { termSpikes: number; unansweredQuestions: number; competitorSpikes: number };
  inserted: number;
  merged: number;
  bridged: number;
}

export async function scanSignals(orgId: string, siteId: string, opts: { embedder?: Embedder; sql?: postgres.Sql; now?: Date } = {}): Promise<SignalScanSummary> {
  const sql = opts.sql ?? appDb();
  const now = opts.now ?? new Date();
  const [termSpikes, unanswered, competitorSpikes] = await Promise.all([
    detectTermSpikes(orgId, siteId, sql, now),
    detectUnansweredQuestions(orgId, siteId, sql),
    detectCompetitorSpikes(orgId, siteId, sql, now),
  ]);
  const { inserted, merged } = await upsertSignals(orgId, siteId, [...termSpikes, ...unanswered, ...competitorSpikes], { ...opts, sql, now });
  const { bridged } = await bridgeSignalsToOpportunities(orgId, siteId, sql);
  return { detected: { termSpikes: termSpikes.length, unansweredQuestions: unanswered.length, competitorSpikes: competitorSpikes.length }, inserted, merged, bridged };
}
