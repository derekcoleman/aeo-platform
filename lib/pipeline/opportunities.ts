import type postgres from "postgres";
import { listEntities } from "@/lib/context/entities";
import { appDb } from "@/lib/db/app";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { citationGaps, type CitationGap } from "@/lib/demand/store";
import { demandFromImpressions, REFRESH_MIN_AGE_DAYS, refreshGapType, type RefreshSignals } from "@/lib/refresh/score";
import { matchTopic } from "@/lib/strategy/topics";

/**
 * The ranked queue. `score_breakdown` is stored next to `score` so a number
 * is arguable rather than magic, and `dedupe_key` stops the nightly scan
 * reopening the same gap.
 *
 * Every producer (the citation-gap scan, "Write about this", the
 * post-publish loop, the refresh scan, the signal bridge, the competitor
 * organic gap) scores with one function, scoreEV0, so their numbers
 * compare: the expected value of doing the work, divided by what the work
 * costs.
 */

// ── EV0: the unified expected-value scorer ──────────────────────────────────

export const EV0_VERSION = "ev0-2026-10";

export const ACTION_TYPES = ["new_page", "refresh", "expand", "consolidate", "update_stats", "setup_task"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Relative effort, a refresh being 1: a statistics update is half of one, a new page two. */
export const ACTION_EFFORT: Record<ActionType, number> = { update_stats: 0.5, refresh: 1, expand: 1.5, new_page: 2, consolidate: 2.5, setup_task: 1 };

export const GAP_TYPES = [
  "aio_named_competitor", "aio_other_sources", "organic_competitor", "unanswered_signal",
  "refresh_lost_citation", "refresh_decline", "refresh_stale", "manual",
] as const;
export type GapType = (typeof GAP_TYPES)[number];

/**
 * How likely the work is to move the number, by the kind of gap it closes.
 * Uncalibrated priors (the outcome data to fit them does not exist yet): a
 * named rival holding the AI Overview is a gap a better answer wins; a page
 * that lost a citation has shown it can earn one; staleness alone is a weak
 * reason. A person's request is taken at its word.
 */
export const GAP_PRIORS: Record<GapType, number> = {
  aio_named_competitor: 0.6,
  aio_other_sources: 0.45,
  organic_competitor: 0.4,
  unanswered_signal: 0.3,
  refresh_lost_citation: 0.6,
  refresh_decline: 0.5,
  refresh_stale: 0.3,
  manual: 1,
};

const GAP_LABELS: Record<GapType, string> = {
  aio_named_competitor: "AI Overview gap, a named competitor cited",
  aio_other_sources: "AI Overview gap, other sources cited",
  organic_competitor: "a competitor ranks, we do not",
  unanswered_signal: "an unanswered buyer question",
  refresh_lost_citation: "a citation lost",
  refresh_decline: "traffic declining",
  refresh_stale: "stale",
  manual: "asked for by a person",
};

export const SEARCH_INTENTS = ["transactional", "commercial", "comparison", "informational", "navigational"] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

/** Buyers comparing or ready to buy are worth more than readers; someone looking for a login page is not ours to win. */
export const INTENT_WEIGHTS: Record<SearchIntent, number> = { transactional: 1.5, commercial: 1.5, comparison: 1.3, informational: 1, navigational: 0.5 };

/** The intents a keyword data provider reports (measure.questions.search_intent). */
const PROVIDER_INTENTS = new Set<string>(["transactional", "commercial", "informational", "navigational"]);

export type IntentSource = "provider" | "text" | "default";

const COMPARISON_RE = /\b(vs|versus|compare[ds]?|comparing|comparison|alternatives?|difference between|differences between)\b/;
const TRANSACTIONAL_RE = /\b(buy|purchase|order|quote|demo|free trial|trial|discount|coupon)\b/;
const COMMERCIAL_RE = /\b(best|top \d+|top|review|reviews|pricing|price|prices|cost|costs|software|tools?|platforms?|vendors?|providers?|solutions?)\b/;
const NAVIGATIONAL_RE = /\b(login|log in|sign in|signin|download|contact|customer service|phone number)\b/;

/**
 * The query's intent: the provider's when it measured one, otherwise read
 * from the wording (comparison first: "okta vs entra pricing" is a
 * comparison), otherwise informational.
 */
export function resolveIntent(text: string, stored?: string | null): { value: SearchIntent; source: IntentSource } {
  if (stored && PROVIDER_INTENTS.has(stored)) return { value: stored as SearchIntent, source: "provider" };
  const t = normalizeQuestion(text);
  if (COMPARISON_RE.test(t)) return { value: "comparison", source: "text" };
  if (TRANSACTIONAL_RE.test(t)) return { value: "transactional", source: "text" };
  if (COMMERCIAL_RE.test(t)) return { value: "commercial", source: "text" };
  if (NAVIGATIONAL_RE.test(t)) return { value: "navigational", source: "text" };
  return { value: "informational", source: "default" };
}

export interface DemandSignals {
  /** Monthly searches from a keyword data provider. */
  searchVolume?: number | null;
  /** The site's Search Console impressions on the query, 28 days. Zero says only that the site does not rank yet. */
  queryImpressions?: number | null;
  /** A page's own Search Console impressions, 28 days (a refresh). Zero is real: nobody sees the page. */
  pageImpressions?: number | null;
  /** The mined demand score: how often discovery surfaced the phrasing. The cold-start fallback. */
  demandScore?: number | null;
}

export type DemandSource = "search_volume" | "gsc_page_impressions" | "gsc_query_impressions" | "demand_score" | "default";

/** Demand when nothing measured it: neutral. */
export const COLD_START_DEMAND = 50;

const clamp100 = (n: number) => Math.max(0, Math.min(100, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Monthly search volume on a log scale: 10 ≈ 25, 100 ≈ 50, 1,000 ≈ 75, 10,000 or more = 100. */
export function demandFromVolume(volume: number): number {
  if (!(volume > 0)) return 0;
  return clamp100((Math.log10(1 + volume) / 4) * 100);
}

/**
 * Demand 0–100: measured volume, else Search Console impressions, else the
 * mined score (a cold start). A provider's volume of 0 is a measurement (the
 * keyword is below what it can count), not a cold start: it scores 0, unless
 * the site's own Search Console saw people search the query, which is the
 * more direct observation.
 */
export function ev0Demand(d: DemandSignals): { value: number; source: DemandSource; coldStart: boolean; input: number | null } {
  if (d.searchVolume != null && d.searchVolume > 0) return { value: round2(demandFromVolume(d.searchVolume)), source: "search_volume", coldStart: false, input: d.searchVolume };
  if (d.pageImpressions != null && d.pageImpressions >= 0) return { value: round2(demandFromImpressions(d.pageImpressions)), source: "gsc_page_impressions", coldStart: false, input: d.pageImpressions };
  if (d.queryImpressions != null && d.queryImpressions > 0) return { value: round2(demandFromImpressions(d.queryImpressions)), source: "gsc_query_impressions", coldStart: false, input: d.queryImpressions };
  if (d.searchVolume === 0) return { value: 0, source: "search_volume", coldStart: false, input: 0 };
  if (d.demandScore != null && Number.isFinite(d.demandScore)) return { value: round2(clamp100(d.demandScore)), source: "demand_score", coldStart: true, input: d.demandScore };
  return { value: COLD_START_DEMAND, source: "default", coldStart: true, input: null };
}

export interface TopicWeight {
  id: string;
  priority: number;
  formats: string[];
  status: "active" | "paused" | "archived";
  /** Name and seed terms, for matching a title to its topic and for topical fit. */
  name?: string;
  seed_terms?: string[];
}

/** Business value a question on no topic gets when the site has none to compare it with: neutral. */
export const NEUTRAL_BUSINESS_VALUE = 50;

/**
 * Business value for a question on no topic: never above what the site's
 * median active topic is worth (lower median, so a site with priority 1 and 2
 * topics gives 20), and never above 60. The old neutral 50 put any stray
 * question ahead of every priority-1 and priority-2 topic the customer chose.
 */
export function defaultBusinessValue(topics: Map<string, TopicWeight>): number {
  const priorities = [...topics.values()].filter((t) => t.status === "active").map((t) => t.priority).sort((a, b) => a - b);
  if (priorities.length === 0) return NEUTRAL_BUSINESS_VALUE;
  const median = priorities[Math.floor((priorities.length - 1) / 2)]!;
  return Math.min(60, median * 20);
}

/** The same rule on EV0's 0–1 scale: min(0.6, median priority / 5), 0.5 with no topics. */
export function topiclessValue(topics: Map<string, TopicWeight>): number {
  return defaultBusinessValue(topics) / 100;
}

export interface BrandFit {
  value: number;
  reason: string;
  term?: string;
}

export interface EV0Input {
  demand: DemandSignals;
  intent: { value: SearchIntent; source: IntentSource };
  gapType: GapType;
  /** The opportunity's topic; a paused or archived one is worth what a question on no topic is. */
  topic?: TopicWeight | null;
  /** Business value of a question on no topic (topiclessValue); neutral 0.5 when not given. */
  topicless?: number;
  /** 0–1: how firmly the work belongs to what the site is about (topicalFit). */
  brandFit: BrandFit;
  actionType: ActionType;
}

export interface EV0Breakdown {
  formula: "ev0";
  version: typeof EV0_VERSION;
  ev: number;
  components: {
    demand: ReturnType<typeof ev0Demand>;
    intent: { value: SearchIntent; source: IntentSource; weight: number };
    gap: { type: GapType; prior: number };
    businessValue: { value: number; source: "topic" | "topicless"; priority?: number };
    brandFit: BrandFit;
    effort: { action: ActionType; value: number };
  };
  /** Filled once outcomes calibrate the priors; EV0 makes no lift prediction. */
  predictedLift: null;
}

export interface ScoredEV0 {
  score: number;
  breakdown: EV0Breakdown;
}

/**
 * EV = demand (0–100) × intent weight × gap prior × business value (topic
 * priority / 5) × brand fit ÷ effort. Every factor is stored in the
 * breakdown with where it came from, so a rank can be argued with.
 */
export function scoreEV0(i: EV0Input): ScoredEV0 {
  const demand = ev0Demand(i.demand);
  const intentWeight = INTENT_WEIGHTS[i.intent.value];
  const prior = GAP_PRIORS[i.gapType];
  const topic = i.topic && i.topic.status === "active" ? i.topic : null;
  const businessValue = topic
    ? { value: round2(Math.max(1, Math.min(5, topic.priority)) / 5), source: "topic" as const, priority: topic.priority }
    : { value: round2(Math.max(0, Math.min(1, i.topicless ?? NEUTRAL_BUSINESS_VALUE / 100))), source: "topicless" as const };
  const brandFit = { ...i.brandFit, value: Math.max(0, Math.min(1, i.brandFit.value)) };
  const effort = ACTION_EFFORT[i.actionType];
  const ev = round2((demand.value * intentWeight * prior * businessValue.value * brandFit.value) / effort);
  return {
    score: ev,
    breakdown: {
      formula: "ev0",
      version: EV0_VERSION,
      ev,
      components: {
        demand,
        intent: { ...i.intent, weight: intentWeight },
        gap: { type: i.gapType, prior },
        businessValue,
        brandFit,
        effort: { action: i.actionType, value: effort },
      },
      predictedLift: null,
    },
  };
}

const DEMAND_LABELS: Record<DemandSource, string> = {
  search_volume: "search volume",
  gsc_page_impressions: "page impressions",
  gsc_query_impressions: "query impressions",
  demand_score: "mined, cold start",
  default: "unmeasured, cold start",
};

/** One line a person can argue with: each factor and where it came from. Null for a breakdown from before EV0. */
export function explainEV0(breakdown: unknown): string | null {
  const b = breakdown as Partial<EV0Breakdown> | null;
  if (!b || b.formula !== "ev0" || !b.components) return null;
  const c = b.components;
  const bv = c.businessValue.source === "topic" ? `priority ${c.businessValue.priority}/5` : "no topic";
  return [
    `demand ${Math.round(c.demand.value)} (${DEMAND_LABELS[c.demand.source]})`,
    `× ${c.intent.value} ${c.intent.weight}`,
    `× ${GAP_LABELS[c.gap.type]} ${c.gap.prior}`,
    `× ${bv} ${c.businessValue.value}`,
    `× fit ${c.brandFit.value}`,
    `÷ ${c.effort.action.replace("_", " ")} ${c.effort.value}`,
    `= ${b.ev}`,
  ].join(" ");
}

// ── topical fit ─────────────────────────────────────────────────────────────

/**
 * Brand fit from what the site is about: 1 on one of its active topics, 0.6
 * when the wording names one of its seed terms, keywords or entities (its
 * brand, products, features, integrations, categories, competitors), 0.3
 * when nothing ties it to the site. 0.3 is the floor: the pipeline does not
 * write an automated opportunity there (a person can still ask for it).
 */
export const TOPICAL_FIT = { topic: 1, overlap: 0.6, none: 0.3 } as const;
export const TOPICAL_FLOOR = TOPICAL_FIT.none;

/** The entity types whose names tie a question to the site. A customer or a person does not. */
const TOPICAL_ENTITY_TYPES = ["brand", "product", "feature", "integration", "category", "competitor"] as const;

export interface TopicalContext {
  topics: Map<string, TopicWeight>;
  /** Normalised terms (≥ 3 characters) with the raw spelling, for the reason. */
  terms: { norm: string; raw: string; kind: "seed" | "keyword" | "entity" }[];
}

function addTerm(out: TopicalContext["terms"], seen: Set<string>, raw: string, kind: TopicalContext["terms"][number]["kind"]) {
  const norm = normalizeQuestion(raw);
  if (norm.length < 3 || seen.has(norm)) return;
  seen.add(norm);
  out.push({ norm, raw: raw.trim(), kind });
}

/** Topic names and seed terms only (no keywords or entities): the context a caller without a database has. */
export function topicalContextFrom(topics: Map<string, TopicWeight>, extra: { keywords?: string[]; entities?: { name: string; aliases: string[] }[] } = {}): TopicalContext {
  const terms: TopicalContext["terms"] = [];
  const seen = new Set<string>();
  for (const t of topics.values()) {
    if (t.status === "archived") continue;
    for (const s of [...(t.seed_terms ?? []), ...(t.name ? [t.name] : [])]) addTerm(terms, seen, s, "seed");
  }
  for (const k of extra.keywords ?? []) addTerm(terms, seen, k, "keyword");
  for (const e of extra.entities ?? []) for (const a of [e.name, ...e.aliases]) addTerm(terms, seen, a, "entity");
  // Longest first, so the reason names the most specific term.
  terms.sort((a, b) => b.norm.length - a.norm.length);
  return { topics, terms };
}

export function topicalFit(text: string, topicId: string | null | undefined, ctx: TopicalContext): BrandFit {
  const topic = topicId ? ctx.topics.get(topicId) : undefined;
  if (topic?.status === "active") return { value: TOPICAL_FIT.topic, reason: `on the active topic ${topic.name ? `"${topic.name}"` : topic.id}` };
  const padded = ` ${normalizeQuestion(text)} `;
  const hit = ctx.terms.find((t) => padded.includes(` ${t.norm} `));
  if (hit) return { value: TOPICAL_FIT.overlap, reason: `names the ${hit.kind === "entity" ? "entity" : hit.kind === "keyword" ? "keyword" : "seed term"} "${hit.raw}"`, term: hit.raw };
  return { value: TOPICAL_FIT.none, reason: "no topic, seed term, keyword or brand entity of the site in the question" };
}

export function belowTopicalFloor(fit: BrandFit): boolean {
  return fit.value <= TOPICAL_FLOOR;
}

/** Work on the customer's own page, or asked for by a person: it belongs to the site by definition. */
export const OWN_PAGE_FIT: BrandFit = { value: 1, reason: "the site's own page" };
export const MANUAL_FIT: BrandFit = { value: 1, reason: "asked for by a person" };

export async function loadTopicalContext(siteId: string, sql: postgres.Sql = appDb(), topics?: Map<string, TopicWeight>): Promise<TopicalContext> {
  const [site] = await sql<{ org_id: string; keywords: string[] | null; profile_keywords: unknown }[]>`
    select org_id, keywords, profile->'keywords' as profile_keywords from app.sites where id = ${siteId}`;
  const weights = topics ?? (await loadTopicWeights(siteId, sql));
  const keywords = [...(site?.keywords ?? []), ...(Array.isArray(site?.profile_keywords) ? (site.profile_keywords as unknown[]).filter((k): k is string => typeof k === "string") : [])];
  const entities = site ? await listEntities(site.org_id, sql, [...TOPICAL_ENTITY_TYPES]) : [];
  return topicalContextFrom(weights, { keywords, entities });
}

// ── question demand ─────────────────────────────────────────────────────────

export interface QuestionDemand {
  id: string;
  text: string;
  topic_id: string | null;
  demand_score: number;
  search_volume: number | null;
  search_intent: string | null;
  /** The site's Search Console impressions on the query over 28 days, matched on its wording. */
  query_impressions: number | null;
}

export async function loadQuestionDemand(siteId: string, questionIds: string[], sql: postgres.Sql = appDb()): Promise<Map<string, QuestionDemand>> {
  const ids = [...new Set(questionIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await sql<QuestionDemand[]>`
    select q.id, q.text, q.topic_id, q.demand_score::float as demand_score, q.search_volume, q.search_intent,
           (select sum((m.metrics->>'impressions')::numeric) from measure.external_metrics m
            where m.site_id = q.site_id and m.provider = 'gsc' and m.surface = 'gsc_query' and m.date >= current_date - 28
              and lower(btrim(m.dimension->>'query')) in (q.normalized, lower(btrim(q.text))))::float as query_impressions
    from measure.questions q
    where q.site_id = ${siteId} and q.id = any(${sql.array(ids)}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

export function demandOf(q: QuestionDemand | undefined, fallbackScore?: number | null): DemandSignals {
  return { searchVolume: q?.search_volume ?? null, queryImpressions: q?.query_impressions ?? null, demandScore: q?.demand_score ?? fallbackScore ?? null };
}

// ── opportunities ───────────────────────────────────────────────────────────

export interface OpportunityInput {
  source: "citation_gap" | "question_graph" | "signal" | "gsc" | "manual" | "refresh" | "competitor";
  title: string;
  targetQuery: string;
  questionId?: string | null;
  contentItemId?: string | null;
  /** The context.signals row that raised this, for lineage back to the evidence. */
  signalId?: string | null;
  topicId?: string | null;
  /** Preferred article format, from the topic or a manual request. */
  format?: "comparison" | "howto" | "guide" | "listicle" | "faq" | null;
  /** The work it is; new_page when not given. */
  actionType?: ActionType;
  score: number;
  scoreBreakdown: Record<string, unknown>;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

/**
 * The queue key for work on one question. Every producer that writes about a
 * question goes through here, so a later change of key (to an intent cluster)
 * changes them together.
 */
export function opportunityKey(question: { id: string }): string {
  return `question:${question.id}`;
}

/**
 * Citation gaps → opportunities. The gap is the strongest signal we have:
 * one a named competitor holds is worth more than one forums, review sites
 * and publishers hold (Reddit in an AI Overview is a reason to answer the
 * question, not a rival). A paused topic contributes nothing new; a question
 * on no topic is worth at most the median topic (topiclessValue); the
 * topic's first preferred format becomes the brief's format hint.
 */
export function opportunitiesFromCitationGaps(
  gaps: CitationGap[],
  topics: Map<string, TopicWeight> = new Map(),
  ctx: { demand?: Map<string, QuestionDemand>; fit?: TopicalContext } = {},
): OpportunityInput[] {
  const out: OpportunityInput[] = [];
  const topicless = topiclessValue(topics);
  const fit = ctx.fit ?? topicalContextFrom(topics);
  for (const g of gaps) {
    const topic = g.topic_id ? topics.get(g.topic_id) : undefined;
    if (topic && topic.status !== "active") continue;
    const q = ctx.demand?.get(g.question_id);
    const scored = scoreEV0({
      demand: demandOf(q, g.demand_score),
      intent: resolveIntent(g.text, q?.search_intent),
      gapType: g.named_competitors > 0 ? "aio_named_competitor" : "aio_other_sources",
      topic,
      topicless,
      brandFit: topicalFit(g.text, g.topic_id, fit),
      actionType: "new_page",
    });
    out.push({
      source: "citation_gap",
      title: g.text,
      targetQuery: g.text,
      questionId: g.question_id,
      topicId: g.topic_id ?? null,
      format: (topic?.formats[0] as OpportunityInput["format"]) ?? null,
      actionType: "new_page",
      score: scored.score,
      scoreBreakdown: scored.breakdown as unknown as Record<string, unknown>,
      evidence: { snapshotId: g.snapshot_id, provider: g.provider, competitorDomains: g.competitor_domains, namedCompetitorDomains: g.named_competitor_domains, namedCompetitors: g.named_competitors, fetchedAt: g.fetched_at, topicId: g.topic_id ?? null },
      dedupeKey: opportunityKey({ id: g.question_id }),
    });
  }
  return out;
}

export interface UpsertSummary {
  inserted: number;
  updated: number;
}

/**
 * Insert new opportunities; re-score open ones; never touch queued/in-progress/
 * published rows, nor dismissed ones but for two the pipeline's guard
 * dismissed for a reason that can pass (lib/pipeline/coverage.ts), which come
 * back to the queue: work below the topical floor once its question scores
 * above it (added to a topic, or a seed term that names it), and new-page
 * work turned away because the page that covers it changed too recently or
 * had other work on it, once REFRESH_MIN_AGE_DAYS have passed. The guard
 * looks again when it runs.
 *
 * Several producers share a dedupe key (a citation gap and an unanswered-
 * question signal are both `question:<id>`), and each used to overwrite the
 * other's evidence and score. Now every producer's evidence is kept under
 * `evidence.bySource.<source>` (the row's first producer is filed there the
 * first time another one writes), the top-level keys merge with the latest
 * producer's winning, and the score is replaced only when the row's own
 * source re-scores it; another producer can only raise it. A person's
 * request merged into a scanned row ("Write about this" on a gap) counts as
 * another producer even to the row's own: its next scan can raise the score
 * but not take the manual prior away. A score from before EV0 (no
 * `formula: "ev0"` in its breakdown) is on another scale and is always
 * replaced. The action follows the row's own producer too, except
 * that work already pointed at an existing page (by the coverage guard, or a
 * refresh) is never turned back into a new page: its brief would start from
 * a blank page while the run rewrites the live one.
 */
export async function upsertOpportunities(siteId: string, rows: OpportunityInput[], sql: postgres.Sql = appDb()): Promise<UpsertSummary> {
  let inserted = 0;
  let updated = 0;
  // The incoming score replaces the stored one (rather than only raising it): see above.
  const replaces = sql`(content.opportunities.score_breakdown->>'formula' is distinct from 'ev0'
    or (content.opportunities.source = excluded.source and (content.opportunities.evidence->>'manual' is distinct from 'true' or excluded.evidence->>'manual' = 'true')))`;
  for (const r of rows) {
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into content.opportunities (site_id, source, title, target_query, question_id, content_item_id, signal_id, topic_id, format, score, score_breakdown, evidence, dedupe_key, action_type)
      values (${siteId}, ${r.source}, ${r.title}, ${r.targetQuery}, ${r.questionId ?? null}, ${r.contentItemId ?? null}, ${r.signalId ?? null}, ${r.topicId ?? null}, ${r.format ?? null},
              ${r.score}, ${sql.json(r.scoreBreakdown as never)}, ${sql.json(r.evidence as never)}, ${r.dedupeKey}, ${r.actionType ?? "new_page"})
      on conflict (site_id, dedupe_key) do update
        set score = case when ${replaces} then excluded.score else greatest(content.opportunities.score, excluded.score) end,
            score_breakdown = case when ${replaces} or excluded.score > content.opportunities.score
                                   then excluded.score_breakdown else content.opportunities.score_breakdown end,
            action_type = case when content.opportunities.source <> excluded.source then content.opportunities.action_type
                               when excluded.action_type = 'new_page' and (content.opportunities.content_item_id is not null or content.opportunities.evidence->>'cmsItemId' is not null)
                                 then content.opportunities.action_type
                               else excluded.action_type end,
            evidence = (content.opportunities.evidence - 'bySource') || excluded.evidence || jsonb_build_object('bySource',
              coalesce(content.opportunities.evidence->'bySource', jsonb_build_object(content.opportunities.source::text, content.opportunities.evidence))
              || jsonb_build_object(excluded.source::text, excluded.evidence)),
            signal_id = coalesce(excluded.signal_id, content.opportunities.signal_id),
            topic_id = coalesce(excluded.topic_id, content.opportunities.topic_id),
            format = coalesce(content.opportunities.format, excluded.format),
            status = 'open', updated_at = now()
        where content.opportunities.status = 'open'
           or (content.opportunities.status = 'dismissed' and (
                (content.opportunities.dismiss_reason = 'auto_topical_floor'
                  and (excluded.score_breakdown->'components'->'brandFit'->>'value')::float > ${TOPICAL_FLOOR})
                or (content.opportunities.dismiss_reason = 'auto_coverage' and content.opportunities.action_type = 'new_page'
                  and content.opportunities.updated_at < now() - make_interval(days => ${REFRESH_MIN_AGE_DAYS}))))
      returning (xmax = 0) as inserted`;
    if (!row) continue;
    if (row.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

export async function loadTopicWeights(siteId: string, sql: postgres.Sql = appDb()): Promise<Map<string, TopicWeight>> {
  const rows = await sql<TopicWeight[]>`select id, priority, formats, status, name, seed_terms from measure.topics where site_id = ${siteId}`;
  return new Map(rows.map((t) => [t.id, t]));
}

// ── rows scored before EV0 ──────────────────────────────────────────────────

/** An open row as the scorer needs it, whatever produced it. */
export type StoredOpportunity = Pick<OpportunityRow, "id" | "source" | "action_type" | "title" | "target_query" | "question_id" | "topic_id" | "evidence">;

const numberOr = (v: unknown, fallback: number | null): number | null => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * The EV0 inputs of a row, from what its producer stored: a person's request
 * takes the manual prior; a refresh-scan row its page's impressions and the
 * gap its stored signals show; a post-publish refresh the gap its article
 * was written for; a signal the unanswered-question prior; a keyword a
 * named competitor outranks us on the organic-competitor prior; a citation
 * gap the prior for who holds the answer. The same inputs each producer scores
 * a new row on.
 */
export function storedEV0Input(
  r: StoredOpportunity,
  ctx: { demand: Map<string, QuestionDemand>; topics: Map<string, TopicWeight>; topicless: number; fit: TopicalContext },
): EV0Input {
  const q = r.question_id ? ctx.demand.get(r.question_id) : undefined;
  const topicId = r.topic_id ?? q?.topic_id ?? null;
  const base = { intent: resolveIntent(r.target_query, q?.search_intent), topic: topicId ? (ctx.topics.get(topicId) ?? null) : null, topicless: ctx.topicless, actionType: r.action_type ?? "new_page" };
  if (isManualOpportunity(r)) return { ...base, demand: demandOf(q), gapType: "manual", brandFit: MANUAL_FIT };
  if (r.source === "refresh") {
    const signals = r.evidence.signals as RefreshSignals | undefined;
    if (r.evidence.kind === "cms_refresh" && signals?.gsc && signals.citations) {
      return {
        ...base,
        topic: base.topic ?? topicForTitle(r.target_query, ctx.topics),
        demand: { pageImpressions: signals.gsc.available ? signals.gsc.impressions : null },
        gapType: refreshGapType(signals),
        brandFit: OWN_PAGE_FIT,
      };
    }
    // The post-publish loop: the gap the article was written for is still open.
    return { ...base, demand: demandOf(q), gapType: "aio_other_sources", brandFit: OWN_PAGE_FIT };
  }
  const brandFit = topicalFit(r.target_query, topicId, ctx.fit);
  if (r.source === "signal") return { ...base, demand: demandOf(q, numberOr(r.evidence.demandScore, null)), gapType: "unanswered_signal", brandFit };
  if (r.source === "competitor") return { ...base, demand: demandOf(q), gapType: "organic_competitor", brandFit };
  return { ...base, demand: demandOf(q), gapType: (numberOr(r.evidence.namedCompetitors, null) ?? 0) > 0 ? "aio_named_competitor" : "aio_other_sources", brandFit };
}

/**
 * Bring rows scored before EV0 onto its scale. The old weighted sum put a
 * person's request near 63 and a gap near 50, where EV0 scores the same work
 * at about 3 to 35, and most of those rows would never be scored again (a
 * manual row waits for another request, a signal is bridged once, a refresh
 * window opens once, a gap that closed is not scanned): left alone they would
 * sit above everything EV0 ranks. The migration cannot score them (the
 * inputs are topic weights, Search Console demand and topical fit), so every
 * scan re-scores the open, queued and running ones still on the old formula
 * with their own producer's inputs (storedEV0Input), once.
 */
export async function rescoreLegacyOpportunities(
  siteId: string,
  sql: postgres.Sql = appDb(),
  ctx: { topics?: Map<string, TopicWeight>; fit?: TopicalContext } = {},
): Promise<{ rescored: number }> {
  const rows = await sql<StoredOpportunity[]>`
    select id, source, action_type, title, target_query, question_id, topic_id, evidence
    from content.opportunities
    where site_id = ${siteId} and status in ('open', 'queued', 'in_progress') and score_breakdown->>'formula' is distinct from 'ev0'
    order by created_at limit 2000`;
  if (rows.length === 0) return { rescored: 0 };
  const topics = ctx.topics ?? (await loadTopicWeights(siteId, sql));
  const [demand, fit] = await Promise.all([
    loadQuestionDemand(siteId, rows.map((r) => r.question_id ?? ""), sql),
    ctx.fit ? Promise.resolve(ctx.fit) : loadTopicalContext(siteId, sql, topics),
  ]);
  const scoring = { demand, topics, topicless: topiclessValue(topics), fit };
  const updates = rows.map((r) => {
    const scored = scoreEV0(storedEV0Input(r, scoring));
    return { id: r.id, score: scored.score, breakdown: scored.breakdown };
  });
  // One statement; a row a producer re-scored meanwhile is already on EV0 and keeps that score.
  const done = await sql<{ id: string }[]>`
    update content.opportunities o set score = v.score, score_breakdown = v.breakdown
    from jsonb_to_recordset(${sql.json(updates as never)}) as v(id uuid, score numeric, breakdown jsonb)
    where o.id = v.id and o.site_id = ${siteId} and o.score_breakdown->>'formula' is distinct from 'ev0'
    returning o.id`;
  return { rescored: done.length };
}

export async function scanSite(siteId: string, sql: postgres.Sql = appDb(), limit = 100): Promise<UpsertSummary & { gaps: number; rescored: number }> {
  // Topic weights also set what a question on no topic is worth (topiclessValue) and anchor topical fit.
  const [gaps, topics] = await Promise.all([citationGaps(siteId, limit, sql), loadTopicWeights(siteId, sql)]);
  const [demand, fit] = await Promise.all([loadQuestionDemand(siteId, gaps.map((g) => g.question_id), sql), loadTopicalContext(siteId, sql, topics)]);
  // Old-formula rows first, so a gap merging into one compares two EV0 scores.
  const { rescored } = await rescoreLegacyOpportunities(siteId, sql, { topics, fit });
  const summary = await upsertOpportunities(siteId, opportunitiesFromCitationGaps(gaps, topics, { demand, fit }), sql);
  return { ...summary, gaps: gaps.length, rescored };
}

export interface ManualOpportunityInput {
  title: string;
  targetQuery?: string | null;
  questionId?: string | null;
  topicId?: string | null;
  format?: OpportunityInput["format"];
  note?: string | null;
}

/**
 * "Write about this": a hand-made opportunity, tied to its topic and format.
 * A person's request carries the highest prior and full fit, so it outranks
 * any scanned gap of the same demand. A request about a question the queue
 * already holds merges into that row (and reopens it when it had stopped).
 */
export async function createManualOpportunity(siteId: string, input: ManualOpportunityInput, sql: postgres.Sql = appDb()): Promise<{ id: string }> {
  const title = input.title.trim();
  const targetQuery = (input.targetQuery ?? title).trim();
  const dedupeKey = input.questionId ? opportunityKey({ id: input.questionId }) : `manual:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;
  const [demand, topics] = await Promise.all([loadQuestionDemand(siteId, input.questionId ? [input.questionId] : [], sql), loadTopicWeights(siteId, sql)]);
  const q = input.questionId ? demand.get(input.questionId) : undefined;
  const topicId = input.topicId ?? q?.topic_id ?? null;
  const scored = scoreEV0({
    demand: demandOf(q),
    intent: resolveIntent(targetQuery, q?.search_intent),
    gapType: "manual",
    topic: topicId ? topics.get(topicId) : null,
    topicless: topiclessValue(topics),
    brandFit: MANUAL_FIT,
    actionType: "new_page",
  });
  const [row] = await sql<{ id: string }[]>`
    insert into content.opportunities (site_id, source, title, target_query, question_id, topic_id, format, score, score_breakdown, evidence, dedupe_key, action_type)
    values (${siteId}, 'manual', ${title}, ${targetQuery}, ${input.questionId ?? null}, ${topicId}, ${input.format ?? null},
            ${scored.score}, ${sql.json(scored.breakdown as never)}, ${sql.json({ manual: true, note: input.note ?? null } as never)}, ${dedupeKey}, 'new_page')
    on conflict (site_id, dedupe_key) do update
      set status = case when content.opportunities.status in ('dismissed', 'failed', 'published') then 'open' else content.opportunities.status end,
          -- Asked for again after it stopped: the per-article cost cap starts over (assertArticleBudget).
          cost_cap_reset_at = case when content.opportunities.status in ('dismissed', 'failed', 'published') then now() else content.opportunities.cost_cap_reset_at end,
          -- A setup task the guard turned away is a page again once a person asks for one; a refresh stays one.
          action_type = case when content.opportunities.action_type = 'setup_task' then 'new_page' else content.opportunities.action_type end,
          title = excluded.title, topic_id = coalesce(excluded.topic_id, content.opportunities.topic_id), format = coalesce(excluded.format, content.opportunities.format),
          -- A score from before EV0 is on another scale: replaced, not compared.
          score = case when content.opportunities.score_breakdown->>'formula' is distinct from 'ev0' then excluded.score
                       else greatest(content.opportunities.score, excluded.score) end,
          score_breakdown = case when content.opportunities.score_breakdown->>'formula' is distinct from 'ev0' or excluded.score >= content.opportunities.score
                                 then excluded.score_breakdown else content.opportunities.score_breakdown end,
          evidence = (content.opportunities.evidence - 'bySource') || excluded.evidence || jsonb_build_object('bySource',
            coalesce(content.opportunities.evidence->'bySource', jsonb_build_object(content.opportunities.source::text, content.opportunities.evidence))
            || jsonb_build_object(excluded.source::text, excluded.evidence)),
          updated_at = now()
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
  action_type: ActionType;
  title: string;
  target_query: string;
  question_id: string | null;
  content_item_id: string | null;
  topic_id: string | null;
  format: OpportunityInput["format"];
  score: number;
  evidence: Record<string, unknown>;
  /** Present where a read model selects it (the queue does, for the explanation). */
  score_breakdown?: Record<string, unknown>;
}

/** Work on a page that already exists (its brief and draft start from the live article), rather than a new page. */
export function refreshesExistingPage(o: { source: string; action_type?: ActionType | null }): boolean {
  return o.source === "refresh" || o.action_type === "refresh" || o.action_type === "update_stats" || o.action_type === "expand";
}

/** Raised by a person: made by hand, or merged with a hand-made request ("Write about this" on a question the queue held). */
export function isManualOpportunity(o: Pick<OpportunityRow, "source" | "evidence">): boolean {
  return o.source === "manual" || o.evidence?.manual === true;
}

export async function loadOpportunity(id: string, sql: postgres.Sql = appDb()): Promise<OpportunityRow | null> {
  const [row] = await sql<OpportunityRow[]>`
    select id, org_id, site_id, source, status, action_type, title, target_query, question_id, content_item_id, topic_id, format, score::float as score, evidence
    from content.opportunities where id = ${id}`;
  return row ?? null;
}

export async function markOpportunity(id: string, status: OpportunityRow["status"], sql: postgres.Sql = appDb(), reason?: string): Promise<void> {
  await sql`update content.opportunities set status = ${status}, dismissed_reason = coalesce(${reason ?? null}, dismissed_reason), updated_at = now() where id = ${id}`;
}

/** A run that stopped for a reason with a name (a model refusal): failed, with the reason kept for the queue's history. */
export async function markFailed(id: string, detail: string, reason: DismissReason, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update content.opportunities set status = 'failed', dismissed_reason = ${detail}, dismiss_reason = ${reason}, updated_at = now() where id = ${id}`;
}

export const DISMISS_REASONS = [
  "not_relevant", "duplicate", "covered_elsewhere", "off_brand", "low_value", "other",
  "auto_coverage", "auto_velocity", "auto_topical_floor", "model_refusal",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** The reasons a person picks from; the rest are the pipeline's. */
export const PERSON_DISMISS_REASONS: { value: DismissReason; label: string }[] = [
  { value: "not_relevant", label: "Not relevant" },
  { value: "duplicate", label: "Duplicate" },
  { value: "covered_elsewhere", label: "Covered elsewhere" },
  { value: "off_brand", label: "Off brand" },
  { value: "low_value", label: "Low value" },
  { value: "other", label: "Other" },
];

/**
 * Dismiss with a reason (content.dismiss_reason) and its detail. Only an
 * open, queued or in-progress row is dismissed: a published or failed one
 * keeps its outcome.
 */
export async function dismissOpportunity(
  id: string,
  reason: DismissReason,
  detail: string | null,
  sql: postgres.Sql = appDb(),
  opts: { actionType?: ActionType } = {},
): Promise<{ applied: boolean }> {
  const rows = await sql<{ id: string }[]>`
    update content.opportunities
    set status = 'dismissed', dismiss_reason = ${reason}, dismissed_reason = ${detail},
        action_type = coalesce(${opts.actionType ?? null}::content.action_type, action_type), updated_at = now()
    where id = ${id} and status in ('open', 'queued', 'in_progress')
    returning id`;
  return { applied: rows.length > 0 };
}

/**
 * Open a refresh opportunity for an asset that did not earn its citation.
 * Idempotent per (item, window). `gapType` says what the window found: a
 * citation the page had and lost, or a gap it has not closed yet.
 */
export async function openRefreshOpportunity(
  input: { siteId: string; contentItemId: string; questionId: string | null; topicId?: string | null; gapType?: GapType; title: string; targetQuery: string; windowDays: number; evidence: Record<string, unknown> },
  sql: postgres.Sql = appDb(),
): Promise<UpsertSummary> {
  const [demand, topics] = await Promise.all([loadQuestionDemand(input.siteId, input.questionId ? [input.questionId] : [], sql), loadTopicWeights(input.siteId, sql)]);
  const q = input.questionId ? demand.get(input.questionId) : undefined;
  const topicId = input.topicId ?? q?.topic_id ?? null;
  const scored = scoreEV0({
    demand: demandOf(q),
    intent: resolveIntent(input.targetQuery, q?.search_intent),
    gapType: input.gapType ?? "refresh_lost_citation",
    topic: topicId ? topics.get(topicId) : null,
    topicless: topiclessValue(topics),
    brandFit: OWN_PAGE_FIT,
    actionType: "refresh",
  });
  return upsertOpportunities(
    input.siteId,
    [
      {
        source: "refresh",
        title: `Refresh: ${input.title}`,
        targetQuery: input.targetQuery,
        questionId: input.questionId,
        contentItemId: input.contentItemId,
        topicId,
        actionType: "refresh",
        score: scored.score,
        scoreBreakdown: scored.breakdown as unknown as Record<string, unknown>,
        evidence: input.evidence,
        dedupeKey: `refresh:${input.contentItemId}:${input.windowDays}d`,
      },
    ],
    sql,
  );
}

/** The topic a page title belongs to, by its seed terms (matchTopic), for scoring work that has no question. */
export function topicForTitle(title: string, topics: Map<string, TopicWeight>): TopicWeight | null {
  const m = matchTopic(title, [...topics.values()].map((t) => ({ id: t.id, name: t.name ?? "", seed_terms: t.seed_terms ?? [], priority: t.priority, status: t.status })));
  return m ? topics.get(m.topicId) ?? null : null;
}
