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
 */

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Provider-reported spend when available (OpenRouter returns it); else estimated by the caller. */
  costUsd?: number;
}

export interface CompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask for a bare JSON object. Callers still validate with Zod. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface TextModel {
  readonly id: string;
  complete(prompt: string, opts?: CompletionOptions): Promise<{ text: string; usage: CompletionUsage }>;
}

export type LlmProvider = "openrouter" | "anthropic";
type Env = Record<string, string | undefined>;

export const DEFAULT_AUDIT_MODEL = process.env.AEO_AUDIT_MODEL ?? "claude-sonnet-5";

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

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

/** Direct Messages API client. No SDK dependency; one fetch, one shape. */
export function anthropicModel(model = DEFAULT_AUDIT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl: typeof fetch = fetch): TextModel {
  return {
    id: model,
    async complete(prompt, opts = {}) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      const system = withJsonInstruction(opts.system, opts.json);
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: opts.signal ?? null,
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 2048,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as AnthropicResponse;
      const text = data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return { text, usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, model: data.model } };
    },
  };
}

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Sent as HTTP-Referer / X-Title; OpenRouter shows them in its usage dashboard. */
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}

interface OpenRouterResponse {
  model?: string;
  choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/** OpenRouter chat-completions client. `model` may be an Anthropic id or a full OpenRouter slug. */
export function openRouterModel(model = DEFAULT_AUDIT_MODEL, options: OpenRouterOptions = {}): TextModel {
  const env = process.env;
  const apiKey = options.apiKey ?? env.OPENROUTER_API_KEY;
  const baseUrl = (options.baseUrl ?? env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const referer = options.referer ?? env.APP_URL;
  const title = options.title ?? "AEO Platform";
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
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
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
      const content = data.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          model: data.model ?? slug,
          ...(typeof data.usage?.cost === "number" ? { costUsd: data.usage.cost } : {}),
        },
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
      return openRouterModel(id, { apiKey: env.OPENROUTER_API_KEY, baseUrl: env.OPENROUTER_BASE_URL, referer: env.APP_URL });
    case "anthropic":
      return anthropicModel(id, env.ANTHROPIC_API_KEY);
    default:
      return unavailableModel();
  }
}

export function defaultModel(): TextModel {
  return modelFromEnv(DEFAULT_AUDIT_MODEL);
}
