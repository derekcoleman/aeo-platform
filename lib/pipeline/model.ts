import type { ZodType } from "zod";
import { anthropicModel, unavailableModel, type TextModel } from "@/lib/ai/model";
import { parseScoredJson } from "@/lib/ai/scored-json";
import { appDb } from "@/lib/db/app";
import type postgres from "postgres";
import type { ModelRun } from "./types";

/**
 * Task → model routing for the pipeline. The full ModelRouter (config in
 * ops.model_routes, fallbacks, per-org budgets) is a later slice; this reads
 * env so the routing is at least not a constant, and every call still lands
 * in ops.llm_calls with its task key so cost per article is a query today.
 */

export type TaskKey = "pipeline.brief" | "pipeline.draft" | "pipeline.qa.judge" | "context.facts.extract" | "context.manifest.draft";

const TASK_ENV: Record<TaskKey, string> = {
  "pipeline.brief": "AEO_MODEL_BRIEF",
  "pipeline.draft": "AEO_MODEL_DRAFT",
  "pipeline.qa.judge": "AEO_MODEL_QA_JUDGE",
  "context.facts.extract": "AEO_MODEL_FACTS_EXTRACT",
  "context.manifest.draft": "AEO_MODEL_MANIFEST_DRAFT",
};

// Extraction is a classification job at volume: small model, strict schema.
// The manifesto is editorial: mid model, a human edits it anyway.
const DEFAULTS: Record<TaskKey, string> = {
  "pipeline.brief": "claude-opus-5",
  "pipeline.draft": "claude-opus-5",
  "pipeline.qa.judge": "claude-sonnet-5",
  "context.facts.extract": "claude-haiku-4-5-20251001",
  "context.manifest.draft": "claude-sonnet-5",
};

export function modelIdFor(task: TaskKey, env: NodeJS.ProcessEnv = process.env): string {
  return env[TASK_ENV[task]] ?? env.AEO_MODEL_DEFAULT ?? DEFAULTS[task];
}

export function modelFor(task: TaskKey, env: NodeJS.ProcessEnv = process.env): TextModel {
  const id = modelIdFor(task, env);
  return env.ANTHROPIC_API_KEY ? anthropicModel(id, env.ANTHROPIC_API_KEY) : unavailableModel(`ANTHROPIC_API_KEY is not set (task ${task})`);
}

/** USD per million tokens, [input, output]. Overridable; billing truth is the provider invoice, not this. */
const PRICE_PER_M: Record<string, [number, number]> = {
  "claude-opus-5": [15, 75],
  "claude-sonnet-5": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(PRICE_PER_M).find((k) => model.startsWith(k));
  const [inP, outP] = key ? PRICE_PER_M[key]! : [5, 25];
  return Math.round(((inputTokens * inP + outputTokens * outP) / 1_000_000) * 1e5) / 1e5;
}

export interface LlmCallScope {
  orgId: string;
  siteId?: string | null;
  contentItemId?: string | null;
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
  maxTokens?: number;
  temperature?: number;
}

/**
 * One JSON-returning model call: complete → validate → ledger. Callers never
 * see raw text, and a schema failure is a thrown ScoredJsonError the stage
 * can retry with feedback rather than a half-parsed object.
 */
export async function runJsonTask<T>(
  task: TaskKey,
  model: TextModel,
  input: TaskInput,
  schema: ZodType<T>,
  scope: LlmCallScope,
  sql: postgres.Sql = appDb(),
): Promise<{ value: T; run: ModelRun }> {
  const { text, usage } = await model.complete(input.prompt, {
    system: input.system,
    json: true,
    maxTokens: input.maxTokens ?? 8192,
    temperature: input.temperature ?? 0.3,
  });
  const run: ModelRun = {
    model: usage.model,
    promptVersion: input.promptVersion,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens),
  };
  await recordLlmCall(task, scope, run, sql);
  const value = parseScoredJson<T>(text, schema);
  return { value, run };
}
