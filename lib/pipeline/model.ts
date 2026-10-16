import type { ZodType } from "zod";
import { bareModelId, ModelRefusalError, modelFromEnv, type Completion, type Effort, type TextModel } from "@/lib/ai/model";
import { parseScoredJson, ScoredJsonError } from "@/lib/ai/scored-json";
import { appDb } from "@/lib/db/app";
import type postgres from "postgres";
import type { ModelRun } from "./types";

/**
 * Task → model routing for the pipeline. The full ModelRouter (config in
 * ops.model_routes, fallbacks, per-org budgets) is a later slice; this reads
 * env so the routing is at least not a constant, and every call still lands
 * in ops.llm_calls with its task key so cost per article is a query today.
 */

export type TaskKey = "pipeline.brief" | "pipeline.draft" | "pipeline.qa.judge" | "context.facts.extract" | "context.manifest.draft" | "site.profile.extract";

const TASK_ENV: Record<TaskKey, string> = {
  "pipeline.brief": "AEO_MODEL_BRIEF",
  "pipeline.draft": "AEO_MODEL_DRAFT",
  "pipeline.qa.judge": "AEO_MODEL_QA_JUDGE",
  "context.facts.extract": "AEO_MODEL_FACTS_EXTRACT",
  "context.manifest.draft": "AEO_MODEL_MANIFEST_DRAFT",
  "site.profile.extract": "AEO_MODEL_PROFILE",
};

// Extraction is a classification job at volume: small model, strict schema.
// The manifesto is editorial: mid model, a human edits it anyway.
const DEFAULTS: Record<TaskKey, string> = {
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
export const TASK_SETTINGS: Record<TaskKey, TaskSettings> = {
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

export function modelIdFor(task: TaskKey, env: NodeJS.ProcessEnv = process.env): string {
  return env[TASK_ENV[task]] ?? env.AEO_MODEL_DEFAULT ?? DEFAULTS[task];
}

export function modelFor(task: TaskKey, env: NodeJS.ProcessEnv = process.env): TextModel {
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
  /** The Inngest run and the opportunity the call served. Carried for the spend ledger; ops.llm_calls does not store them yet. */
  runId?: string | null;
  opportunityId?: string | null;
}

export async function recordLlmCall(task: TaskKey, scope: LlmCallScope, run: ModelRun, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`
    insert into ops.llm_calls (org_id, site_id, task_key, model, prompt_version, input_tokens, output_tokens, cost_usd, content_item_id)
    values (${scope.orgId}, ${scope.siteId ?? null}, ${task}, ${run.model}, ${run.promptVersion},
            ${run.inputTokens}, ${run.outputTokens}, ${run.costUsd}, ${scope.contentItemId ?? null})`;
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
 */
export async function runJsonTask<T>(
  task: TaskKey,
  model: TextModel,
  input: TaskInput,
  schema: ZodType<T>,
  scope: LlmCallScope,
  sql: postgres.Sql = appDb(),
): Promise<{ value: T; run: ModelRun }> {
  const settings = TASK_SETTINGS[task];
  const call = async (maxTokens: number) => {
    const out = await model.complete(input.prompt, {
      system: input.system,
      json: true,
      maxTokens,
      effort: input.effort ?? settings.effort,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });
    const run = runOf(input, out);
    await recordLlmCall(task, scope, run, sql);
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
