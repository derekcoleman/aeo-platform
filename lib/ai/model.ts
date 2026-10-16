/**
 * The narrowest model interface the audit and the pipeline need: text in,
 * text out, with a usage record. Two providers behind it:
 *
 * - OpenRouter (default when OPENROUTER_API_KEY is set): OpenAI-style chat
 *   completions at openrouter.ai, any model in its catalogue. Claude ids
 *   written the Anthropic way ("claude-opus-5") are translated to the
 *   OpenRouter slug ("anthropic/claude-opus-5") so one set of AEO_MODEL_*
 *   variables works for both providers.
 * - Anthropic Messages API directly (ANTHROPIC_API_KEY).
 *
 * AEO_LLM_PROVIDER=openrouter|anthropic forces one when both keys exist.
 * JSON is requested with an instruction, never an assistant prefill: the
 * Claude 5 / 4.6+ models reject prefills, and callers validate with Zod
 * (lib/ai/scored-json.ts extracts the object from surrounding prose).
 *
 * The Claude 5 family (and Opus 4.7+) reject sampling parameters with a 400,
 * think adaptively inside `max_tokens`, and can decline a request with a
 * `refusal` stop reason. So `temperature` is dropped for those ids, depth is
 * steered with `effort`, and every completion reports how it stopped: a
 * truncated answer or a refusal is data the caller acts on, not a parse error.
 */

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Provider-reported spend when available (OpenRouter returns it); else estimated by the caller. */
  costUsd?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Thinking depth and overall token spend on models that support it. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Why generation stopped, normalised across providers. */
export type StopReason = "end_turn" | "max_tokens" | "refusal" | "other";

export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  /** Dropped for models that reject sampling parameters (see supportsSamplingParams). */
  temperature?: number;
  /** Sent as output_config.effort on the Anthropic API; on OpenRouter only with AEO_OPENROUTER_REASONING=1. */
  effort?: Effort;
  /** Ask for a bare JSON object. Callers still validate with Zod. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface Completion {
  text: string;
  usage: CompletionUsage;
  /** Absent only from stand-in models; treat as a normal finish. */
  stopReason?: StopReason;
  /** The provider's refusal category (Anthropic `stop_details.category`), when it gave one. */
  refusalCategory?: string | null;
}

export interface TextModel {
  readonly id: string;
  complete(prompt: string, opts?: CompletionOptions): Promise<Completion>;
}

/** The model declined the request. Retrying the same prompt will not help; a human should look. */
export class ModelRefusalError extends Error {
  constructor(
    public readonly model: string,
    public readonly category: string | null,
  ) {
    super(`${model} declined the request${category ? ` (${category})` : ""}`);
    this.name = "ModelRefusalError";
  }
}

export type LlmProvider = "openrouter" | "anthropic";
type Env = Record<string, string | undefined>;

export const DEFAULT_AUDIT_MODEL = process.env.AEO_AUDIT_MODEL ?? "claude-sonnet-5-5";

const JSON_INSTRUCTION = "Respond with a single JSON object and nothing else: no prose before or after it, no code fence.";

function withJsonInstruction(system: string | undefined, json: boolean | undefined): string | undefined {
  if (!json) return system;
  return system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
}

/** Which provider a given environment selects, or null when no key is set. */
export function llmProvider(env: Env = process.env): LlmProvider | null {
  const forced = env.AEO_LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "openrouter") return env.OPENROUTER_API_KEY ? "openrouter" : null;
  if (forced === "anthropic") return env.ANTHROPIC_API_KEY ? "anthropic" : null;
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function llmConfigured(env: Env = process.env): boolean {
  return llmProvider(env) !== null;
}

export const LLM_NOT_CONFIGURED = "No model key is set: add OPENROUTER_API_KEY (or ANTHROPIC_API_KEY).";

/**
 * Translate an Anthropic-style model id to OpenRouter's slug. Ids that already
 * carry a vendor prefix ("openai/gpt-5", "anthropic/claude-opus-5") pass
 * through untouched. "claude-haiku-4-5-20251001" → "anthropic/claude-haiku-4.5".
 */
export function toOpenRouterModel(id: string): string {
  if (id.includes("/")) return id;
  let slug = id.replace(/-\d{8}$/, "");
  slug = slug.replace(/^(claude-[a-z]+)-(\d+)-(\d+)$/, "$1-$2.$3");
  return `anthropic/${slug}`;
}

/** The bare Anthropic-style id: vendor prefix and date suffix stripped, OpenRouter's dots as dashes. */
export function bareModelId(id: string): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
}

function claudeVersion(id: string): { family: string; major: number; minor: number } | null {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/.exec(bareModelId(id));
  return m ? { family: m[1]!, major: Number(m[2]), minor: Number(m[3] ?? 0) } : null;
}

/**
 * Whether `temperature` (and the other sampling parameters) may be sent.
 * Every Claude 5 model and Opus 4.7+ reject them with a 400 (Sonnet 5.5 and
 * Haiku 5.5 reject any non-default value, which is the only kind worth
 * sending). Other vendors' models keep them.
 */
export function supportsSamplingParams(id: string): boolean {
  const v = claudeVersion(id);
  if (!v) return true;
  if (v.major >= 5) return false;
  return !(v.family === "opus" && v.major === 4 && v.minor >= 7);
}

/** `output_config.effort` exists on Claude 5, Opus 4.5+ and Sonnet 4.6; older models reject it. */
export function supportsEffort(id: string): boolean {
  const v = claudeVersion(id);
  if (!v) return false;
  if (v.major >= 5) return true;
  return v.major === 4 && ((v.family === "opus" && v.minor >= 5) || (v.family === "sonnet" && v.minor >= 6));
}

/** Models that take server-side refusal fallbacks in the `"default"` form (Haiku 5.5 has none). */
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export function supportsServerFallbacks(id: string): boolean {
  return SERVER_FALLBACK_MODELS.has(bareModelId(id));
}

export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";

function anthropicStopReason(reason: string | null | undefined): StopReason {
  return reason === "end_turn" || reason === "max_tokens" || reason === "refusal" ? reason : "other";
}

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
  model: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
}

/**
 * Direct Messages API client. No SDK dependency; one fetch, one shape. On the
 * models that support it a refusal is retried server-side on Anthropic's
 * recommended fallback model (AEO_ANTHROPIC_FALLBACKS=0 turns that off); the
 * response's `model` then names the model that answered.
 */
export function anthropicModel(model = DEFAULT_AUDIT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl: typeof fetch = fetch, env: Env = process.env): TextModel {
  const fallbacks = supportsServerFallbacks(model) && env.AEO_ANTHROPIC_FALLBACKS !== "0";
  return {
    id: model,
    async complete(prompt, opts = {}) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      const system = withJsonInstruction(opts.system, opts.json);
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: opts.signal ?? null,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(fallbacks ? { "anthropic-beta": SERVER_FALLBACK_BETA } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 2048,
          ...(opts.temperature !== undefined && supportsSamplingParams(model) ? { temperature: opts.temperature } : {}),
          ...(opts.effort && supportsEffort(model) ? { output_config: { effort: opts.effort } } : {}),
          ...(fallbacks ? { fallbacks: "default" } : {}),
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as AnthropicResponse;
      // Thinking and fallback blocks carry no answer text; only text blocks do.
      const text = data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const stopReason = anthropicStopReason(data.stop_reason);
      return {
        text,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          model: data.model,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
        },
        stopReason,
        refusalCategory: stopReason === "refusal" ? (data.stop_details?.category ?? null) : null,
      };
    },
  };
}

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Sent as HTTP-Referer / X-Title; OpenRouter shows them in its usage dashboard. */
  referer?: string;
  title?: string;
  /**
   * Forward `effort` as `reasoning.effort`. Off by default: OpenRouter may
   * translate it into a thinking budget, which the Claude 5 models reject.
   * AEO_OPENROUTER_REASONING=1 turns it on.
   */
  reasoning?: boolean;
  fetchImpl?: typeof fetch;
}

interface OpenRouterResponse {
  model?: string;
  choices?: { finish_reason?: string | null; native_finish_reason?: string | null; message?: { content?: string | { type: string; text?: string }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
  error?: { message?: string };
}

/** OpenRouter normalises `finish_reason`; the provider's own value rides in `native_finish_reason`. */
function openRouterStopReason(finish: string | null | undefined, native: string | null | undefined): StopReason {
  if (finish === "length" || native === "max_tokens") return "max_tokens";
  if (finish === "content_filter" || native === "refusal") return "refusal";
  if (finish === "stop" || native === "end_turn") return "end_turn";
  return "other";
}

/** OpenRouter chat-completions client. `model` may be an Anthropic id or a full OpenRouter slug. */
export function openRouterModel(model = DEFAULT_AUDIT_MODEL, options: OpenRouterOptions = {}): TextModel {
  const env = process.env;
  const apiKey = options.apiKey ?? env.OPENROUTER_API_KEY;
  const baseUrl = (options.baseUrl ?? env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const referer = options.referer ?? env.APP_URL;
  const title = options.title ?? "AEO Platform";
  const reasoning = options.reasoning ?? env.AEO_OPENROUTER_REASONING === "1";
  const fetchImpl = options.fetchImpl ?? fetch;
  const slug = toOpenRouterModel(model);
  return {
    id: slug,
    async complete(prompt, opts = {}) {
      if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
      const system = withJsonInstruction(opts.system, opts.json);
      const messages: { role: "system" | "user"; content: string }[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: opts.signal ?? null,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(referer ? { "HTTP-Referer": referer } : {}),
          "X-Title": title,
        },
        body: JSON.stringify({
          model: slug,
          max_tokens: opts.maxTokens ?? 2048,
          ...(opts.temperature !== undefined && supportsSamplingParams(slug) ? { temperature: opts.temperature } : {}),
          ...(opts.effort && reasoning ? { reasoning: { effort: opts.effort } } : {}),
          messages,
          usage: { include: true },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`openrouter ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as OpenRouterResponse;
      if (data.error?.message) throw new Error(`openrouter: ${data.error.message}`);
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const cached = data.usage?.prompt_tokens_details;
      const stopReason = openRouterStopReason(choice?.finish_reason, choice?.native_finish_reason);
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          model: data.model ?? slug,
          ...(typeof data.usage?.cost === "number" ? { costUsd: data.usage.cost } : {}),
          ...(cached ? { cacheReadTokens: cached.cached_tokens ?? 0, cacheWriteTokens: cached.cache_write_tokens ?? 0 } : {}),
        },
        stopReason,
        refusalCategory: null,
      };
    },
  };
}

/** A model that always fails. The audit's degraded path when no key is configured. */
export function unavailableModel(reason = LLM_NOT_CONFIGURED): TextModel {
  return {
    id: "unavailable",
    async complete() {
      throw new Error(reason);
    },
  };
}

/** The configured provider's client for `id`, or an unavailable model with the reason. */
export function modelFromEnv(id: string, env: Env = process.env): TextModel {
  switch (llmProvider(env)) {
    case "openrouter":
      return openRouterModel(id, { apiKey: env.OPENROUTER_API_KEY, baseUrl: env.OPENROUTER_BASE_URL, referer: env.APP_URL, reasoning: env.AEO_OPENROUTER_REASONING === "1" });
    case "anthropic":
      return anthropicModel(id, env.ANTHROPIC_API_KEY, fetch, env);
    default:
      return unavailableModel();
  }
}

export function defaultModel(): TextModel {
  return modelFromEnv(DEFAULT_AUDIT_MODEL);
}
