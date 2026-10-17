import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { answerEngines, DEFAULT_ANSWER_ENGINES, PROBE_LABEL } from "@/lib/answers/engines";
import { LOW_N, wilson, type Proportion } from "@/lib/answers/stats";

/**
 * Per-engine visibility from our own answer probes (lib/answers): API-grounded
 * probes through OpenRouter, read from measure.v_answer_observations with
 * collection_method api_probe and nothing else. Never blended with Google AI
 * Overview numbers from our SERP trackers, or with Profound's: each is its
 * own card, and none of these numbers is added to another engine's.
 *
 * Over the window, one answer counts per prompt, engine, sample and UTC day
 * (a same-day re-run re-reads the cached answer; it is not a second
 * observation). Every share is a proportion of answers with a 95% Wilson
 * interval:
 *   - mention rate          answers naming the brand or one of its products
 *   - Recommendation Share  answers recommending it (first in a top-level
 *                           list, or a recommending sentence;
 *                           lib/answers/mentions.ts)
 *   - Citation Share        answers citing one of our URLs, out of the
 *                           answers whose sources were observable at all:
 *                           an engine whose search hides its sources has no
 *                           citation share, not a zero one
 *   - per competitor        answers recommending each named competitor
 */

export const ANSWERS_METHODOLOGY_VERSION = "answers-v0";
export const DEFAULT_VISIBILITY_DAYS = 28;

export interface CompetitorRecommendation {
  entity_id: string;
  name: string;
  mentioned: number;
  recommendation: Proportion;
}

export interface EngineVisibility {
  engine: string;
  label: string;
  /** Answers in the window. */
  n: number;
  /** Fewer than LOW_N answers: the intervals are wide, read the share as a range. */
  lowN: boolean;
  mention: Proportion;
  recommendation: Proportion;
  /** Over the n_observable answers whose sources the engine exposed. */
  citation: Proportion;
  nObservable: number;
  competitors: CompetitorRecommendation[];
  /** The models that answered in the window, with how they searched. */
  modelVersions: string[];
  lastObservedAt: string | Date | null;
}

export interface EngineVisibilityReport {
  engines: EngineVisibility[];
  days: number;
  label: string;
  methodologyVersion: string;
}

interface EngineRow {
  engine: string;
  n: number;
  mentioned: number;
  recommended: number;
  n_observable: number;
  cited: number;
  model_versions: string[] | null;
  last_observed_at: string | Date | null;
}

interface CompetitorRow {
  engine: string;
  entity_id: string;
  name: string;
  mentioned: number;
  recommended: number;
}

/** What the UI calls an engine: its configured label, or the default's when the config no longer has it. */
function engineLabel(engine: string): string {
  try {
    const cfg = answerEngines().find((e) => e.engine === engine);
    if (cfg) return cfg.label;
  } catch {
    // A bad AEO_ANSWER_ENGINES fails the sampling job, not this page.
  }
  return Object.hasOwn(DEFAULT_ANSWER_ENGINES, engine) ? DEFAULT_ANSWER_ENGINES[engine]!.label : engine;
}

export async function engineVisibility(
  siteId: string,
  opts: { days?: number; topicId?: string | null } = {},
  sql: postgres.Sql = appDb(),
): Promise<EngineVisibilityReport> {
  const days = opts.days ?? DEFAULT_VISIBILITY_DAYS;
  const topicId = opts.topicId ?? null;
  // The window's observations, one per prompt × engine × sample × wording × UTC day, the latest of each.
  const observations = () => sql`
    select distinct on (o.question_id, o.engine, o.sample_index, o.paraphrase_id, (o.fetched_at at time zone 'utc')::date)
           o.id, o.engine, o.model_version, o.citations_observable, o.fetched_at
    from measure.v_answer_observations o
    join measure.questions q on q.id = o.question_id
    where o.site_id = ${siteId} and o.collection_method = 'api_probe'
      and o.fetched_at >= now() - make_interval(days => ${days})
      and not q.excluded and (${topicId}::uuid is null or o.topic_id = ${topicId}::uuid)
    order by o.question_id, o.engine, o.sample_index, o.paraphrase_id, (o.fetched_at at time zone 'utc')::date, o.fetched_at desc`;
  const [rows, rivals] = await Promise.all([
    sql<EngineRow[]>`
      with obs as (${observations()})
      select o.engine,
             count(*)::int as n,
             count(*) filter (where exists (select 1 from measure.answer_mentions m where m.snapshot_id = o.id and m.is_brand))::int as mentioned,
             count(*) filter (where exists (select 1 from measure.answer_mentions m where m.snapshot_id = o.id and m.is_brand and m.is_recommended))::int as recommended,
             count(*) filter (where o.citations_observable)::int as n_observable,
             count(*) filter (where o.citations_observable and exists (
               select 1 from measure.serp_citations c where c.serp_snapshot_id = o.id and c.is_owned))::int as cited,
             array_agg(distinct o.model_version order by o.model_version) filter (where o.model_version is not null) as model_versions,
             max(o.fetched_at) as last_observed_at
      from obs o
      group by o.engine
      order by o.engine`,
    sql<CompetitorRow[]>`
      with obs as (${observations()})
      select o.engine, e.id as entity_id, e.name,
             count(distinct o.id)::int as mentioned,
             count(distinct o.id) filter (where m.is_recommended)::int as recommended
      from obs o
      join measure.answer_mentions m on m.snapshot_id = o.id and not m.is_brand
      join context.entities e on e.id = m.entity_id and e.type = 'competitor'
      group by o.engine, e.id, e.name
      order by recommended desc, mentioned desc, e.name`,
  ]);
  return { engines: summarizeEngines(rows, rivals), days, label: PROBE_LABEL, methodologyVersion: ANSWERS_METHODOLOGY_VERSION };
}

/** Counts → shares with intervals, the configured engines' order first. Pure; exported for tests. */
export function summarizeEngines(rows: EngineRow[], rivals: CompetitorRow[], labelOf: (engine: string) => string = engineLabel): EngineVisibility[] {
  const order = Object.keys(DEFAULT_ANSWER_ENGINES);
  const rank = (e: string) => (order.includes(e) ? order.indexOf(e) : order.length);
  return [...rows]
    .sort((a, b) => rank(a.engine) - rank(b.engine) || a.engine.localeCompare(b.engine))
    .map((r) => ({
      engine: r.engine,
      label: labelOf(r.engine),
      n: r.n,
      lowN: r.n < LOW_N,
      mention: wilson(r.mentioned, r.n),
      recommendation: wilson(r.recommended, r.n),
      citation: wilson(r.cited, r.n_observable),
      nObservable: r.n_observable,
      competitors: rivals
        .filter((c) => c.engine === r.engine)
        .map((c) => ({ entity_id: c.entity_id, name: c.name, mentioned: c.mentioned, recommendation: wilson(c.recommended, r.n) })),
      modelVersions: r.model_versions ?? [],
      lastObservedAt: r.last_observed_at,
    }));
}
