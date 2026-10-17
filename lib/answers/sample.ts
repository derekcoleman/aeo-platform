import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { TRACKING_PLAN_STATUSES, TRACKING_SITE_STATUSES, type SiteOwnership } from "@/lib/demand/store";
import { ANSWER_PROBE_TASK_KEY, BudgetExceededError, type Reservation, type SpendGovernor } from "@/lib/ops/spend";
import { recordLlmCall } from "@/lib/pipeline/model";
import { answerCacheKey, type SerpCache } from "@/lib/serp/cache";
import { searchTag, type AnswerEngineConfig } from "./engines";
import { AnswerProbeError, unusableAnswer, type ProbeResult } from "./openrouter-probe";
import { recordAnswerObservation, type ObservationResult } from "./record";

/**
 * Native answer sampling: which sites are sampled, which prompts, and one
 * sample end to end. The weekly job (lib/inngest/answers.ts) runs one durable
 * step per prompt × engine × sample, each through sampleAnswer:
 *   what the step paid for on an earlier attempt (a step that runs again
 *   re-reads its own answer), else the day's answer cache, else a hold on
 *   the org's answer_probe budget (BudgetExceededError when it is spent,
 *   before anything is paid), the probe, the answer kept for the step and
 *   cached for other runs, the hold settled at what OpenRouter says it cost
 *   (the estimate when it does not) and the call ledgered in ops.llm_calls
 *   as answers.probe, then the answer recorded. A response with no answer in
 *   it (unusableAnswer) is counted and ledgered like any paid call, then
 *   thrown: never cached, never recorded.
 */

/** The org feature that turns sampling on; off by default, set by staff per organisation (Ops → Organisations). */
export const ANSWER_PROBES_FEATURE = "answer_probes";

/** Probes go through OpenRouter only; without its key nothing is sampled. */
export function answerProbesConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.OPENROUTER_API_KEY?.trim();
}
export const ANSWER_PROBE_PROMPT_VERSION = "answers.probe@v0";

/**
 * Steps one run may take for its probes: Inngest stops a run at 1,000 steps,
 * and the run needs a few of its own. The panel is cut to fit
 * (engines × samples × prompts ≤ this).
 */
export const MAX_PROBE_STEPS = 900;

export interface PanelQuestion {
  id: string;
  text: string;
  locale: string;
  device: "desktop" | "mobile";
}

/**
 * A site's prompt panel: its tracked prompts that are not excluded, pinned
 * first, then by demand, at most `size`.
 */
export async function loadAnswerPanel(siteId: string, size: number, sql: postgres.Sql = appDb()): Promise<PanelQuestion[]> {
  return sql<PanelQuestion[]>`
    select id, text, locale, device from measure.questions
    where site_id = ${siteId} and is_tracked and not excluded
    order by pinned desc, demand_score desc, seen_count desc, id
    limit ${size}`;
}

/** The panel cut to what one run's steps allow. Pure. */
export function fitPanel<T>(panel: T[], engines: number, samples: number, maxSteps = MAX_PROBE_STEPS): T[] {
  const per = Math.max(1, engines) * Math.max(1, samples);
  return panel.slice(0, Math.max(0, Math.floor(maxSteps / per)));
}

export interface SampledSite {
  site_id: string;
  org_id: string;
}

/**
 * Sites the weekly run samples (one org's, with `orgId`): the org has the
 * feature on, the site is tracked (not paused or disabled, plan not lapsed,
 * as the SERP schedulers require) and has at least one prompt on its panel.
 */
export async function sitesForAnswerProbes(orgId: string | null = null, sql: postgres.Sql = appDb()): Promise<SampledSite[]> {
  return sql<SampledSite[]>`
    select s.id as site_id, s.org_id
    from app.sites s
    join app.organizations o on o.id = s.org_id
    where (${orgId}::uuid is null or o.id = ${orgId}::uuid)
      and s.status::text = any (${[...TRACKING_SITE_STATUSES]}::text[])
      and o.plan_status = any (${[...TRACKING_PLAN_STATUSES]}::text[])
      and app.org_feature_enabled(o.id, ${ANSWER_PROBES_FEATURE})
      and exists (select 1 from measure.questions q where q.site_id = s.id and q.is_tracked and not q.excluded)
    order by s.org_id, s.id`;
}

const PROBE_RETRIES = 2;

/**
 * What the job does with a sample that failed, as serp-track does with a
 * snapshot. A spent budget halts the run. A request the engine refused
 * (a 4xx: a wrong slug, a rejected parameter), or answered with nothing in a
 * way it will repeat, goes the same way again: skip it. Anything else (a
 * timeout, a 5xx or 429, an answer that failed upstream, a database blip) is
 * thrown for Inngest to retry the step, and skipped on the last attempt. Pure.
 */
export function probeFailure(error: unknown, attempt: number, retries = PROBE_RETRIES): "budget" | "retry" | "skip" {
  if (error instanceof BudgetExceededError) return "budget";
  if ((error instanceof AnswerProbeError && error.permanent) || attempt >= retries) return "skip";
  return "retry";
}
export const ANSWER_PROBE_RETRIES = PROBE_RETRIES;

export interface SampleDeps {
  sql: postgres.Sql;
  cache: SerpCache;
  governor: SpendGovernor;
  probe: (cfg: AnswerEngineConfig, prompt: string) => Promise<ProbeResult>;
}

export interface SampleInput {
  own: SiteOwnership;
  question: PanelQuestion;
  engine: AnswerEngineConfig;
  sampleIndex: number;
  runId: string | null;
  /**
   * The day (YYYY-MM-DD) the run's answers are cached under: fixed with the
   * run's plan, not read off the clock at each attempt, so a step retried
   * after midnight still finds what it paid for.
   */
  day: string;
}

export interface SampleResult extends ObservationResult {
  cached: boolean;
  costUsd: number;
}

/** The day's answer to one prompt × engine × sample (answerCacheKey): shared across runs and tenants, read free by all but the step that paid. */
export interface CachedAnswer {
  probe: ProbeResult;
}

/**
 * What one step paid for, under a key of its own (paidAnswerKey): the
 * answer, the hold, the cost and whether the call reached the ledger. Only
 * that step writes or reads it, so another run caching an answer to the same
 * words since cannot take its place. The step, run again after a later
 * failure, finds it: the answer is still its paid one, not a cached one, the
 * hold is settled again (a no-op once settled) and the call ledgered if it
 * never was.
 */
export interface PaidAnswer {
  probe: ProbeResult;
  hold: Reservation;
  costUsd: number;
  ledgered: boolean;
}

/** Where a step keeps what it paid: its run and question ahead of the answer's key, which never starts this way. */
export function paidAnswerKey(answerKey: string, runId: string, questionId: string): string {
  return `paid|${runId}|${questionId}|${answerKey}`;
}

export async function sampleAnswer(input: SampleInput, deps: SampleDeps): Promise<SampleResult> {
  const { own, question, engine, sampleIndex, runId, day } = input;
  const key = answerCacheKey(engine.engine, `${engine.model}${searchTag(engine)}`, sampleIndex, null, question.text, day);
  // Without a run, steps cannot be told apart: nothing is kept for a retry.
  const paidKey = runId === null ? null : paidAnswerKey(key, runId, question.id);
  const [country = "us", language = "en"] = question.locale.split("-");
  // A failed cache write costs a repeat probe later; failing here would have the step retry and pay again now.
  const remember = (k: string, entry: CachedAnswer | PaidAnswer, costUsd: number) =>
    deps.cache
      .set(k, entry, { provider: "openrouter", method: "answer", query: { query: question.text, locale: { country, language }, device: question.device }, day, costUsd })
      .catch((err) => console.warn(`[answers] cache write after a paid ${engine.engine} probe: ${err instanceof Error ? err.message : String(err)}`));
  const keep = (paid: PaidAnswer) => (paidKey ? remember(paidKey, paid, paid.costUsd) : Promise.resolve());
  // Counted, then ledgered: the call is paid for whatever happens next. `ledgered` runs once the row landed.
  const account = async (paid: PaidAnswer, ledgered: () => Promise<void>) => {
    try {
      await deps.governor.settle(paid.hold, paid.costUsd);
    } finally {
      if (!paid.ledgered) {
        await recordLlmCall(
          ANSWER_PROBE_TASK_KEY,
          { orgId: own.orgId, siteId: own.siteId, runId },
          { model: paid.probe.model, promptVersion: ANSWER_PROBE_PROMPT_VERSION, inputTokens: paid.probe.usage.inputTokens, outputTokens: paid.probe.usage.outputTokens, costUsd: paid.costUsd, stopReason: paid.probe.stopReason },
          deps.sql,
        );
        await ledgered();
      }
    }
  };
  const markLedgered = (paid: PaidAnswer) => () => keep({ ...paid, ledgered: true });
  const record = async (probe: ProbeResult, cached: boolean, costUsd: number): Promise<SampleResult> => {
    const rec = await recordAnswerObservation(own, question.id, engine, probe, { sampleIndex, runId, locale: question.locale, cached, costUsd }, deps.sql);
    return { ...rec, cached, costUsd };
  };

  // This step's own answer: it paid, then failed before the answer was recorded. Its accounting is finished here.
  const mine = paidKey ? await deps.cache.get<PaidAnswer>(paidKey) : null;
  if (mine) {
    await account(mine, markLedgered(mine));
    return record(mine.probe, false, mine.costUsd);
  }
  const shared = await deps.cache.get<CachedAnswer>(key);
  if (shared) return record(shared.probe, true, 0);

  const hold = await deps.governor.reserve({
    orgId: own.orgId,
    siteId: own.siteId,
    resource: "answer_probe",
    estimateUsd: engine.estimateUsd,
    ref: { engine: engine.engine, model: engine.model, questionId: question.id, sampleIndex, runId },
  });
  let probe: ProbeResult;
  try {
    probe = await deps.probe(engine, question.text);
  } catch (e) {
    // A failed release must not hide why the probe failed; the sweeper gives the hold back.
    await deps.governor.release(hold).catch((err) => console.warn(`[answers] release after a failed ${engine.engine} probe: ${err instanceof Error ? err.message : String(err)}`));
    throw e;
  }
  const paid: PaidAnswer = { probe, hold, costUsd: probe.usage.costUsd ?? engine.estimateUsd, ledgered: false };
  const unusable = unusableAnswer(probe);
  if (unusable) {
    await account(paid, async () => {});
    throw unusable;
  }
  // Kept before anything else can fail: a step that runs again re-reads it instead of paying twice. Then shared.
  await keep(paid);
  await remember(key, { probe }, paid.costUsd);
  await account(paid, markLedgered(paid));
  return record(probe, false, paid.costUsd);
}
