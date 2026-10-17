import { openRouterStopReason, type StopReason } from "@/lib/ai/model";
import { isValidDomain, normalizeDomain } from "@/lib/measure/source-roles";
import type { AnswerEngineConfig } from "./engines";

/**
 * One answer probe: the prompt, exactly as a buyer would type it, sent to an
 * engine's model through OpenRouter's chat completions with web search on.
 * The user message is the prompt and nothing else: no system prompt, no
 * sampling parameters (temperature and the rest stay at the vendor's
 * defaults, which is what an app's users get), so the answer is the model's
 * own and comparable across runs.
 *
 * Sources are read from the first place that has any:
 *   1. `message.annotations` of type url_citation (OpenRouter's web search,
 *      and the vendors' own search where it reports them);
 *   2. a top-level `citations` list (Perplexity's), referred to in the text
 *      as [1], [2]…;
 *   3. links written into the answer itself.
 * An engine searching with its own back end may return none of these
 * (OpenRouter passes on what the vendor gives). Then `citationsObservable`
 * is false: "cited nothing" and "hid its sources" look the same from the
 * API, so citation share leaves such an answer out rather than counting it
 * as not citing us.
 */

export type CitationSource = "annotation" | "citations" | "inline_link";

export interface ProbeCitation {
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  /** 1-based order in the engine's source list (or in the text, for inline links). */
  position: number;
  /** 1-based order in which the answer first refers to it; null when the text never does. */
  positionInAnswer: number | null;
  source: CitationSource;
}

export interface ProbeResult {
  engine: string;
  /** The slug we asked for (with `:online` when that is how it searched). */
  requestedModel: string;
  /** The model OpenRouter reports answered. */
  model: string;
  text: string;
  citations: ProbeCitation[];
  citationSource: CitationSource | null;
  citationsObservable: boolean;
  finishReason: string | null;
  nativeFinishReason: string | null;
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** The upstream provider OpenRouter routed to, when it says. */
  upstreamProvider: string | null;
  responseId: string | null;
  fetchedAt: string;
}

export interface ProbeOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Sent as HTTP-Referer / X-Title, as lib/ai/model.ts openRouterModel does. */
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export const PROBE_TIMEOUT_MS = 60_000;

/**
 * The request failed, or what came back is not an answer (unusableAnswer).
 * `status` is the HTTP status, null for a network error, a timeout or an
 * unusable answer.
 */
export class AnswerProbeError extends Error {
  constructor(
    public readonly engine: string,
    public readonly status: number | null,
    message: string,
    /** The engine answered, and will answer the same way again. */
    private readonly repeats = false,
  ) {
    super(`${engine} probe: ${message}`);
    this.name = "AnswerProbeError";
  }

  /** The same request will fail again (a bad slug, a rejected parameter, an answer that never starts): record and move on. */
  get permanent(): boolean {
    return this.repeats || (this.status !== null && this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429);
  }
}

/**
 * Why a response that came back, and was paid for, is not an answer to
 * record, or null when it is one. Counted, an answer with nothing in it
 * would read as "brand not mentioned". An upstream error mid-answer is worth
 * another attempt. An empty answer the same request will give again is
 * permanent, so the job skips it instead of paying to retry: a reasoning
 * model that thought until max_tokens (the engine's maxTokens is too low),
 * a refusal, a stop to call a tool nobody runs. An answer cut off after it
 * began is kept, as far as it got; raw.stopReason marks it. Pure.
 */
export function unusableAnswer(probe: ProbeResult): AnswerProbeError | null {
  const fail = (message: string, repeats = false) => new AnswerProbeError(probe.engine, null, message, repeats);
  if (probe.finishReason === "error") return fail(`the answer failed upstream (${probe.nativeFinishReason ?? "finish_reason error"})`);
  if (probe.text.trim()) return null;
  if (probe.stopReason === "max_tokens") return fail(`no answer before max_tokens (${probe.usage.outputTokens} output tokens spent); raise maxTokens for this engine in AEO_ANSWER_ENGINES`, true);
  if (probe.stopReason === "refusal") return fail("the engine refused to answer", true);
  if (probe.finishReason === "tool_calls") return fail("the model stopped to call a tool instead of answering", true);
  return fail(`empty answer (finish_reason ${probe.finishReason ?? "none"})`);
}

/** The chat-completions body for one probe. Pure; exported for tests. */
export function probeRequestBody(cfg: AnswerEngineConfig, prompt: string): Record<string, unknown> {
  const model = cfg.search === "online_suffix" && !cfg.model.endsWith(":online") ? `${cfg.model}:online` : cfg.model;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: cfg.maxTokens,
    usage: { include: true },
  };
  if (cfg.search === "server_tool") {
    body.tools = [{ type: "openrouter:web_search", parameters: { ...(cfg.searchEngine ? { engine: cfg.searchEngine } : {}), max_results: cfg.maxResults } }];
  } else if (cfg.search === "plugin") {
    body.plugins = [{ id: "web", ...(cfg.searchEngine ? { engine: cfg.searchEngine } : {}), max_results: cfg.maxResults }];
  }
  return body;
}

interface UrlCitation {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  start_index?: unknown;
}

interface OpenRouterAnswer {
  id?: string;
  model?: string;
  provider?: string;
  citations?: unknown;
  choices?: {
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: {
      content?: string | { type: string; text?: string }[] | null;
      annotations?: { type?: string; url_citation?: UrlCitation }[] | null;
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text Postgres will store: no NUL (text and jsonb both refuse it) and no
 * half of a surrogate pair (jsonb refuses that). An answer, or a page title
 * or snippet a search returned, can carry either; left in, the snapshot and
 * the cache write would fail on every attempt, each one a paid probe. Pure.
 */
export function storableText(s: string): string {
  return s.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\uFFFD");
}

const str = (v: unknown): string | null => (typeof v === "string" ? storableText(v).trim() || null : null);

function httpUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

interface Candidate {
  url: string;
  title: string | null;
  snippet: string | null;
  /** Where in the text the answer refers to it, when known. */
  offsets: number[];
}

/** Candidates in source-list order → citations, deduplicated by URL, ranked by first reference in the text. */
function toCitations(candidates: Candidate[], source: CitationSource): ProbeCitation[] {
  const byUrl = new Map<string, Candidate>();
  for (const c of candidates) {
    const seen = byUrl.get(c.url);
    if (seen) seen.offsets.push(...c.offsets);
    else byUrl.set(c.url, { ...c, offsets: [...c.offsets] });
  }
  const kept = [...byUrl.values()].filter((c) => isValidDomain(normalizeDomain(c.url)));
  const firstRef = kept.map((c) => (c.offsets.length ? Math.min(...c.offsets) : Number.POSITIVE_INFINITY));
  const order = [...firstRef.keys()].filter((i) => Number.isFinite(firstRef[i])).sort((a, b) => firstRef[a]! - firstRef[b]!);
  return kept.map((c, i) => {
    const rank = order.indexOf(i);
    return { url: c.url, domain: normalizeDomain(c.url), title: c.title, snippet: c.snippet, position: i + 1, positionInAnswer: rank >= 0 ? rank + 1 : null, source };
  });
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()\[\]"'`]+/g;

/** Sources from the response: annotations, else the top-level list, else links in the text. Pure; exported for tests. */
export function extractCitations(data: Pick<OpenRouterAnswer, "citations" | "choices">, text: string): { citations: ProbeCitation[]; source: CitationSource | null } {
  const annotations = (data.choices?.[0]?.message?.annotations ?? []).filter((a) => a?.type === "url_citation" && a.url_citation);
  const fromAnnotations: Candidate[] = [];
  for (const a of annotations) {
    const url = httpUrl(a.url_citation!.url);
    if (!url) continue;
    const at = a.url_citation!.start_index;
    fromAnnotations.push({ url, title: str(a.url_citation!.title), snippet: str(a.url_citation!.content)?.slice(0, 500).replace(/[\uD800-\uDBFF]$/, "") ?? null, offsets: typeof at === "number" && at >= 0 ? [at] : [] });
  }
  const annotated = toCitations(fromAnnotations, "annotation");
  if (annotated.length) return { citations: annotated, source: "annotation" };

  if (Array.isArray(data.citations)) {
    const refs = [...text.matchAll(/\[(\d{1,3})\]/g)];
    const listed: Candidate[] = [];
    data.citations.forEach((c, i) => {
      const url = httpUrl(typeof c === "string" ? c : (c as { url?: unknown } | null)?.url);
      if (!url) return;
      const title = typeof c === "object" && c !== null ? str((c as { title?: unknown }).title) : null;
      listed.push({ url, title, snippet: null, offsets: refs.filter((r) => Number(r[1]) === i + 1).map((r) => r.index) });
    });
    const cited = toCitations(listed, "citations");
    if (cited.length) return { citations: cited, source: "citations" };
  }

  const inline: Candidate[] = [];
  const spans: [number, number][] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const url = httpUrl(m[2]);
    spans.push([m.index, m.index + m[0].length]);
    if (url) inline.push({ url, title: str(m[1]), snippet: null, offsets: [m.index] });
  }
  for (const m of text.matchAll(BARE_URL)) {
    if (spans.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const url = httpUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (url) inline.push({ url, title: null, snippet: null, offsets: [m.index] });
  }
  inline.sort((a, b) => a.offsets[0]! - b.offsets[0]!);
  const linked = toCitations(inline, "inline_link");
  return linked.length ? { citations: linked, source: "inline_link" } : { citations: [], source: null };
}

/**
 * Ask one engine one prompt. Throws AnswerProbeError when the request fails.
 * A response that came back is returned even when it holds no answer: it
 * was paid for, and the caller counts it before unusableAnswer turns it
 * away.
 */
export async function probeAnswer(cfg: AnswerEngineConfig, prompt: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const env = process.env;
  const apiKey = opts.apiKey ?? env.OPENROUTER_API_KEY;
  const baseUrl = (opts.baseUrl ?? env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const referer = opts.referer ?? env.APP_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  if (!apiKey) throw new AnswerProbeError(cfg.engine, null, "OPENROUTER_API_KEY is not set");
  const body = probeRequestBody(cfg, prompt);
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROBE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(referer ? { "HTTP-Referer": referer } : {}),
        "X-Title": opts.title ?? "AEO Platform",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AnswerProbeError(cfg.engine, null, e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AnswerProbeError(cfg.engine, res.status, `openrouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as OpenRouterAnswer;
  if (data.error?.message) throw new AnswerProbeError(cfg.engine, null, `openrouter: ${data.error.message}`);
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const text = storableText(typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
  const { citations, source } = extractCitations(data, text);
  return {
    engine: cfg.engine,
    requestedModel: body.model as string,
    model: data.model ?? (body.model as string),
    text,
    citations,
    citationSource: source,
    citationsObservable: citations.length > 0,
    finishReason: choice?.finish_reason ?? null,
    nativeFinishReason: choice?.native_finish_reason ?? null,
    stopReason: openRouterStopReason(choice?.finish_reason, choice?.native_finish_reason),
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
    },
    upstreamProvider: data.provider ?? null,
    responseId: data.id ?? null,
    fetchedAt: now().toISOString(),
  };
}
