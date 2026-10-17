import { z } from "zod";
import { toOpenRouterModel } from "@/lib/ai/model";

/**
 * The AI answer engines we sample, as configuration. Every one is reached
 * through OpenRouter (OPENROUTER_API_KEY) with web search on, so what we
 * record is an API-grounded probe: the vendor's model searching the web
 * through its API, not the consumer app a buyer types into (which has its
 * own system prompt, memory, location and retrieval). Every number from
 * these probes is labelled that way, reported per engine, and never added to
 * Google AI Overview numbers from our SERP trackers or to Profound's.
 *
 * AEO_ANSWER_ENGINES (JSON) changes the defaults per engine, or adds one:
 *   {"chatgpt": {"model": "openai/gpt-5"}, "grok": {"model": "x-ai/grok-4", …every field}}
 * AEO_ANSWER_ENGINES_ENABLED (comma-separated) picks which run; all of them
 * by default. A value that does not validate is refused with the reason,
 * never silently replaced by a default.
 *
 * The model slugs are OpenRouter's as of this writing; confirm them against
 * GET /api/v1/models after deploy (a wrong slug fails its probes, which the
 * job records and skips).
 */

export const PROBE_LABEL = "API-grounded probe, not the consumer app";

/**
 * How a probe asks for web search:
 * - server_tool    OpenRouter's `openrouter:web_search` server tool (the current way)
 * - plugin         the older `plugins: [{id: "web"}]` (deprecated by OpenRouter; kept for models the tool does not reach)
 * - online_suffix  the `:online` model variant
 * - native_model   the model searches on its own (Perplexity Sonar)
 * - none           no search: an ungrounded answer
 */
export const SEARCH_MODES = ["server_tool", "plugin", "online_suffix", "native_model", "none"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** OpenRouter web search back ends. `native` is the model vendor's own search, which may return no source annotations. */
export const SEARCH_ENGINES = ["auto", "native", "exa", "firecrawl", "parallel", "perplexity"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

const ENGINE_SLUG = /^[a-z0-9_]+$/;
/** An OpenRouter model slug: `vendor/model`, a variant suffix allowed (`:free`). */
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

const settingsSchema = z.strictObject({
  model: z.string().max(200).regex(MODEL_SLUG, "an OpenRouter model slug, vendor/model"),
  /** What the UI calls it, saying it is the API and not the app. */
  label: z.string().min(3).max(120),
  search: z.enum(SEARCH_MODES),
  searchEngine: z.enum(SEARCH_ENGINES).nullable(),
  /** Search results the engine may read (OpenRouter allows 1–25). */
  maxResults: z.number().int().min(1).max(25),
  /** Output ceiling, thinking included on models that think. */
  maxTokens: z.number().int().min(256).max(32_000),
  /** What one probe is held at on the answer_probe budget before it runs: an upper bound, not a price. */
  estimateUsd: z.number().positive().max(5),
});
export type AnswerEngineSettings = z.infer<typeof settingsSchema>;

export interface AnswerEngineConfig extends AnswerEngineSettings {
  /** The engine's slug: measure.serp_snapshots.engine. */
  engine: string;
}

export const DEFAULT_ANSWER_ENGINES: Readonly<Record<string, AnswerEngineSettings>> = {
  chatgpt: {
    model: "openai/gpt-5-mini",
    label: "OpenAI model via API (not the ChatGPT app)",
    search: "server_tool",
    searchEngine: "native",
    maxResults: 5,
    maxTokens: 4000,
    estimateUsd: 0.05,
  },
  perplexity: {
    model: "perplexity/sonar",
    label: "Perplexity Sonar via API (not the Perplexity app)",
    search: "native_model",
    searchEngine: null,
    maxResults: 5,
    maxTokens: 2000,
    estimateUsd: 0.02,
  },
  gemini: {
    model: "google/gemini-2.5-flash",
    label: "Gemini model via API (not the Gemini app or AI Mode)",
    search: "server_tool",
    searchEngine: "native",
    maxResults: 5,
    maxTokens: 4000,
    estimateUsd: 0.05,
  },
  claude: {
    model: toOpenRouterModel("claude-sonnet-5-5"),
    label: "Claude model via API (not the Claude app)",
    search: "server_tool",
    searchEngine: "native",
    maxResults: 5,
    maxTokens: 4000,
    estimateUsd: 0.1,
  },
};

export class AnswerEngineConfigError extends Error {
  constructor(message: string) {
    super(`answer engines: ${message}`);
    this.name = "AnswerEngineConfigError";
  }
}

type Env = Record<string, string | undefined>;

function issues(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");
}

/**
 * The engines to sample, defaults merged with AEO_ANSWER_ENGINES and
 * filtered by AEO_ANSWER_ENGINES_ENABLED, in a stable order (the defaults',
 * then added ones by name). Throws AnswerEngineConfigError on a value that
 * does not validate.
 */
export function answerEngines(env: Env = process.env): AnswerEngineConfig[] {
  const merged: Record<string, AnswerEngineSettings> = { ...DEFAULT_ANSWER_ENGINES };
  const raw = env.AEO_ANSWER_ENGINES?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AnswerEngineConfigError("AEO_ANSWER_ENGINES is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AnswerEngineConfigError("AEO_ANSWER_ENGINES must be an object of engine → settings");
    for (const [engine, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ENGINE_SLUG.test(engine) || engine.length > 40) throw new AnswerEngineConfigError(`engine name "${engine}" must be lower-case letters, digits and underscores`);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AnswerEngineConfigError(`${engine}: settings must be an object`);
      const base = Object.hasOwn(DEFAULT_ANSWER_ENGINES, engine) ? DEFAULT_ANSWER_ENGINES[engine] : undefined;
      // A known engine takes a partial override; a new one must say everything.
      const result = settingsSchema.safeParse({ ...base, ...(value as object) });
      if (!result.success) throw new AnswerEngineConfigError(`${engine}: ${issues(result.error)}`);
      merged[engine] = result.data;
    }
  }
  const order = [...Object.keys(DEFAULT_ANSWER_ENGINES), ...Object.keys(merged).filter((k) => !Object.hasOwn(DEFAULT_ANSWER_ENGINES, k)).sort()];
  const enabledRaw = env.AEO_ANSWER_ENGINES_ENABLED?.trim();
  let enabled = order;
  if (enabledRaw) {
    const names = [...new Set(enabledRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const unknown = names.filter((n) => !Object.hasOwn(merged, n));
    if (unknown.length) throw new AnswerEngineConfigError(`AEO_ANSWER_ENGINES_ENABLED names unknown engines: ${unknown.join(", ")}`);
    enabled = order.filter((k) => names.includes(k));
  }
  return enabled.map((engine) => ({ engine, ...merged[engine]! }));
}

/** Probes per (prompt, engine) per run: AEO_ANSWER_SAMPLES, 1 by default, at most 3. */
export const MAX_ANSWER_SAMPLES = 3;
/** Prompts on a site's panel: AEO_ANSWER_PANEL_SIZE, 25 by default. */
export const DEFAULT_ANSWER_PANEL_SIZE = 25;
export const MAX_ANSWER_PANEL_SIZE = 100;

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const s = raw?.trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function answerSamples(env: Env = process.env): number {
  return intFromEnv(env.AEO_ANSWER_SAMPLES, 1, 1, MAX_ANSWER_SAMPLES);
}

export function answerPanelSize(env: Env = process.env): number {
  return intFromEnv(env.AEO_ANSWER_PANEL_SIZE, DEFAULT_ANSWER_PANEL_SIZE, 1, MAX_ANSWER_PANEL_SIZE);
}

/** "Google AI Overview" → "google_ai_overview"; empty → "unknown". The same rule as measure.engine_slug(). */
export function answerEngineSlug(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "unknown";
}

export type AnswerSurface = "ai_overview" | "ai_mode" | "llm_answer";

/** The citation surface of an engine's answers. The same rule as measure.answer_surface(). */
export function answerSurface(engine: string): AnswerSurface {
  return engine === "google_aio" ? "ai_overview" : engine === "ai_mode" ? "ai_mode" : "llm_answer";
}

/** How a probe's model searched, as stored in model_version after the model: `+web:native`, `+web:exa`, `+online`, `+native`, `+none`. */
export function searchTag(cfg: Pick<AnswerEngineConfig, "search" | "searchEngine">): string {
  switch (cfg.search) {
    case "server_tool":
    case "plugin":
      return `+web:${cfg.searchEngine ?? "auto"}`;
    case "online_suffix":
      return "+online";
    case "native_model":
      return "+native";
    default:
      return "+none";
  }
}
