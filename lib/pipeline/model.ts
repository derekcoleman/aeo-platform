import type { ZodType } from "zod";
import { bareModelId, ModelRefusalError, modelFromEnv, type Completion, type Effort, type TextModel } from "@/lib/ai/model";
import { parseScoredJson, ScoredJsonError } from "@/lib/ai/scored-json";
import { appDb } from "@/lib/db/app";
import { ANSWER_PROBE_TASK_KEY, defaultSpendGovernor, usdFromEnv, type SpendGovernor } from "@/lib/ops/spend";
import type postgres from "postgres";
import type { ModelRun } from "./types";

/**
 * Task → model routing for the pipeline. The full ModelRouter (config in
 * ops.model_routes, fallbacks) is a later slice; this reads env so the
 * routing is at least not a constant. Every call reserves its worst-case
 * cost against the org's model budget first (lib/ops/spend.ts) and lands in
 * ops.llm_calls with its task key, run and opportunity, so cost per article
 * is a query and the per-article cap is a sum.
 */

/** Tasks the router picks a model for (AEO_MODEL_*). */
export type RoutedTaskKey = "pipeline.brief" | "pipeline.draft" | "pipeline.qa.judge" | "context.facts.extract" | "context.manifest.draft" | "site.profile.extract";
/**
 * Every task a model call is ledgered under: the routed ones, and the answer
 * probes, whose models are the engines' (lib/answers/engines.ts) and whose
 * spend is the answer_probe budget's.
 */
export type TaskKey = RoutedTaskKey | typeof ANSWER_PROBE_TASK_KEY;

const TASK_ENV: Record<RoutedTaskKey, string> = {
  "pipeline.brief": "AEO_MODEL_BRIEF",
  "pipeline.draft": "AEO_MODEL_DRAFT",
  "pipeline.qa.judge": "AEO_MODEL_QA_JUDGE",
  "context.facts.extract": "AEO_MODEL_FACTS_EXTRACT",
  "context.manifest.draft": "AEO_MODEL_MANIFEST_DRAFT",
  "site.profile.extract": "AEO_MODEL_PROFILE",
};

// Extraction is a classification job at volume: small model, strict schema.
// The manifesto is editorial: mid model, a human edits it anyway.
const DEFAULTS: Record<RoutedTaskKey, string> = {
  "pipeline.brief": "claude-opus-5-5",
  "pipeline.draft": "claude-opus-5-5",
  "pipeline.qa.judge": "claude-sonnet-5-5",
  "context.facts.extract": "claude-haiku-5-5",
  "context.manifest.draft": "claude-sonnet-5-5",
  "site.profile.extract": "claude-sonnet-5-5",
};

export interface TaskSettings {
  /** Output ceiling. The Claude 5 models think inside it, so it is sized for thinking plus the JSON. */
  maxTokens: number;
  effort: Effort;
}

/**
 * Per-task output budget and depth. Effort is set explicitly because the
 * defaults differ by model (Opus 5.5 and Haiku 5.5 default to medium). The
 * calls are not streamed, so draft stays at `high`, not `xhigh`: a longer
 * think risks the request timeout before a token arrives.
 */
export const TASK_SETTINGS: Record<RoutedTaskKey, TaskSettings> = {
  "pipeline.brief": { maxTokens: 16_000, effort: "high" },
  "pipeline.draft": { maxTokens: 20_000, effort: "high" },
  "pipeline.qa.judge": { maxTokens: 8_000, effort: "medium" },
  "context.facts.extract": { maxTokens: 16_000, effort: "low" },
  "context.manifest.draft": { maxTokens: 12_000, effort: "medium" },
  "site.profile.extract": { maxTokens: 8_000, effort: "low" },
};

/** A call cut off at `max_tokens` is retried once with half again the room, up to this ceiling. */
export const MAX_TOKENS_CEILING = 32_000;

export function retryMaxTokens(maxTokens: number): number {
  return Math.min(MAX_TOKENS_CEILING, Math.round(maxTokens * 1.5));
}

/**
 * Output cut off at `max_tokens`, handed back to a caller that retries in a
 * step of its own (TaskInput.retryTruncated false). The call is already in
 * the ledger; `retryMaxTokens` is the budget the retry should get.
 */
export class ModelTruncatedError extends Error {
  constructor(
    public readonly model: string,
    public readonly maxTokens: number,
    public readonly retryMaxTokens: number,
  ) {
    super(`${model} output cut off at max_tokens=${maxTokens}`);
    this.name = "ModelTruncatedError";
  }
}

export function modelIdFor(task: RoutedTaskKey, env: NodeJS.ProcessEnv = process.env): string {
  return env[TASK_ENV[task]] ?? env.AEO_MODEL_DEFAULT ?? DEFAULTS[task];
}

export function modelFor(task: RoutedTaskKey, env: NodeJS.ProcessEnv = process.env): TextModel {
  return modelFromEnv(modelIdFor(task, env), env);
}

/**
 * USD per million tokens, [input, output], Anthropic list prices. Used only
 * when the provider did not report spend (OpenRouter does); billing truth is
 * the provider invoice, not this. Ids are normalised first (vendor prefix
 * off, dots to dashes), and the longest matching key wins, so opus-5-5 is
 * not priced as opus-5. Haiku 5.5 is priced at its up-to-100K-token rate.
 */
const PRICE_PER_M: Record<string, [number, number]> = {
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const bare = bareModelId(model);
  const key = Object.keys(PRICE_PER_M)
    .filter((k) => bare.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const [inP, outP] = key ? PRICE_PER_M[key]! : [5, 25];
  return Math.round(((inputTokens * inP + outputTokens * outP) / 1_000_000) * 1e5) / 1e5;
}

export interface LlmCallScope {
  orgId: string;
  siteId?: string | null;
  contentItemId?: string | null;
  /** The Inngest run and the opportunity (article) the call served; the per-article cap sums by the latter. */
  runId?: string | null;
  opportunityId?: string | null;
  /** Budget enforcement. Defaults to defaultSpendGovernor(sql): Postgres when a database is configured, else a no-op. */
  governor?: SpendGovernor;
}

export async function recordLlmCall(task: TaskKey, scope: LlmCallScope, run: ModelRun, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`
    insert into ops.llm_calls (org_id, site_id, task_key, model, prompt_version, input_tokens, output_tokens, cost_usd,
                               cache_creation_input_tokens, cache_read_input_tokens, stop_reason, run_id, opportunity_id, content_item_id)
    values (${scope.orgId}, ${scope.siteId ?? null}, ${task}, ${run.model}, ${run.promptVersion},
            ${run.inputTokens}, ${run.outputTokens}, ${run.costUsd},
            ${run.cacheWriteTokens ?? 0}, ${run.cacheReadTokens ?? 0}, ${run.stopReason ?? null}, ${scope.runId ?? null}, ${scope.opportunityId ?? null},
            ${scope.contentItemId ?? null})`;
}

/** Characters per token for the pre-call estimate: low on purpose, so the hold errs high. */
const CHARS_PER_TOKEN = 3.5;

/** The most a call can cost: the whole prompt in, and every token of `maxTokens` out (thinking included). */
export function worstCaseCostUsd(model: string, input: Pick<TaskInput, "system" | "prompt">, maxTokens: number): number {
  return estimateCostUsd(model, Math.ceil((input.system.length + input.prompt.length) / CHARS_PER_TOKEN), maxTokens);
}

export const DEFAULT_ARTICLE_COST_CAP_USD = 15;

export function articleCostCapUsd(env: Record<string, string | undefined> = process.env): number {
  return usdFromEnv("AEO_ARTICLE_COST_CAP_USD", DEFAULT_ARTICLE_COST_CAP_USD, env);
}

/** One article's model spend reached its cap. Another attempt would add to it; a human decides. */
export class ArticleBudgetExceededError extends Error {
  constructor(
    public readonly opportunityId: string,
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `this article has cost $${spentUsd.toFixed(2)} in model calls, at or over its $${capUsd.toFixed(2)} cap (AEO_ARTICLE_COST_CAP_USD); ` +
        `asking for it again ("Write about this", or "Refresh now" for a refresh) starts a new allowance`,
    );
    this.name = "ArticleBudgetExceededError";
  }
}

/**
 * The per-article cost cap, checked before each brief and draft attempt:
 * every model call made for the opportunity, across runs, against
 * AEO_ARTICLE_COST_CAP_USD (default $15). A loop of QA failures or
 * regenerations stops here instead of at the org's monthly budget. A person
 * reopening the opportunity (content.opportunities.cost_cap_reset_at) starts
 * the count over: that is the per-article way past the cap.
 */
export async function assertArticleBudget(opportunityId: string, sql: postgres.Sql = appDb(), env: Record<string, string | undefined> = process.env): Promise<{ spentUsd: number; capUsd: number }> {
  const capUsd = articleCostCapUsd(env);
  const [row] = await sql<{ spent_usd: number }[]>`
    select coalesce(sum(l.cost_usd), 0)::float as spent_usd
    from ops.llm_calls l
    left join content.opportunities o on o.id = l.opportunity_id
    where l.opportunity_id = ${opportunityId} and l.created_at >= coalesce(o.cost_cap_reset_at, '-infinity')`;
  const spentUsd = row?.spent_usd ?? 0;
  if (spentUsd >= capUsd) throw new ArticleBudgetExceededError(opportunityId, spentUsd, capUsd);
  return { spentUsd, capUsd };
}

export interface TaskInput {
  system: string;
  prompt: string;
  promptVersion: string;
  /** Overrides TASK_SETTINGS; leave unset so the task table stays the one place budgets live. */
  maxTokens?: number;
  effort?: Effort;
  /** Passed through for models that accept it; the Claude 5 family does not. */
  temperature?: number;
  /**
   * False hands output cut off at max_tokens back as ModelTruncatedError
   * instead of retrying it in this call. The calls are not streamed, so a
   * long call and a longer retry in one invocation cannot both finish inside
   * the request timeout; a durable caller retries in a new step instead.
   */
  retryTruncated?: boolean;
}

/** How a caller sizes one call: a budget other than the task table's, and who retries a cut-off. */
export type TaskBudget = Pick<TaskInput, "maxTokens" | "retryTruncated">;

function runOf(input: TaskInput, out: Completion): ModelRun {
  const { usage } = out;
  return {
    model: usage.model,
    promptVersion: input.promptVersion,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd ?? estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(out.stopReason ? { stopReason: out.stopReason } : {}),
  };
}

/**
 * One JSON-returning model call: complete → validate → ledger. Callers never
 * see raw text, and a schema failure is a thrown ScoredJsonError the stage
 * can retry with feedback rather than a half-parsed object.
 *
 * Output cut off at `max_tokens` (thinking spent the budget) is retried once
 * with more room; both calls land in the ledger. With `retryTruncated: false`
 * it is thrown as ModelTruncatedError for the caller to retry. A refusal is
 * recorded, then thrown as ModelRefusalError: it needs a human, not another
 * attempt.
 *
 * Each call holds its worst-case cost on the org's model budget first
 * (BudgetExceededError when there is no room, before anything is paid),
 * settles with what it cost, and gives the hold back if the call throws.
 */
export async function runJsonTask<T>(
  task: RoutedTaskKey,
  model: TextModel,
  input: TaskInput,
  schema: ZodType<T>,
  scope: LlmCallScope,
  sql: postgres.Sql = appDb(),
): Promise<{ value: T; run: ModelRun }> {
  const settings = TASK_SETTINGS[task];
  const governor = scope.governor ?? defaultSpendGovernor(sql);
  const call = async (maxTokens: number) => {
    const hold = await governor.reserve({
      orgId: scope.orgId,
      siteId: scope.siteId ?? null,
      resource: "llm",
      estimateUsd: worstCaseCostUsd(model.id, input, maxTokens),
      ref: { task, model: model.id, maxTokens, runId: scope.runId ?? null, opportunityId: scope.opportunityId ?? null },
    });
    let out: Completion;
    try {
      out = await model.complete(input.prompt, {
        system: input.system,
        json: true,
        maxTokens,
        effort: input.effort ?? settings.effort,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      });
    } catch (e) {
      // A failed release must not hide why the call failed; the sweeper gives the hold back.
      await governor.release(hold).catch((err) => console.warn(`[spend] release after a failed ${task} call: ${err instanceof Error ? err.message : String(err)}`));
      throw e;
    }
    const run = runOf(input, out);
    // Counted before it is ledgered: the money is spent whether or not the row
    // lands. The row lands even when counting failed: the article cap and the
    // next period's counter read the ledger.
    try {
      await governor.settle(hold, run.costUsd);
    } finally {
      await recordLlmCall(task, scope, run, sql);
    }
    if (out.stopReason === "refusal") throw new ModelRefusalError(run.model, out.refusalCategory ?? null);
    return { out, run };
  };
  let maxTokens = input.maxTokens ?? settings.maxTokens;
  let { out, run } = await call(maxTokens);
  if (out.stopReason === "max_tokens" && retryMaxTokens(maxTokens) > maxTokens) {
    if (input.retryTruncated === false) throw new ModelTruncatedError(run.model, maxTokens, retryMaxTokens(maxTokens));
    maxTokens = retryMaxTokens(maxTokens);
    ({ out, run } = await call(maxTokens));
  }
  try {
    return { value: parseScoredJson<T>(out.text, schema), run };
  } catch (e) {
    if (out.stopReason === "max_tokens" && e instanceof ScoredJsonError) throw new ScoredJsonError(`output cut off at max_tokens=${maxTokens}: ${e.message}`, e.raw);
    throw e;
  }
}
