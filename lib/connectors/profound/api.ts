import { z } from "zod";
import type { ProfoundCitation, ProfoundRecord } from "./csv";
import { domainOf, normalizeEngine } from "./csv";

/**
 * Profound REST client (Enterprise plan). Everything it returns is normalised
 * into ProfoundRecord — the same shape the CSV path produces — so one ingest
 * routine serves both.
 *
 * Paths, auth and shapes follow Profound's official TypeScript SDK
 * (`@profoundai/client`): the base is `https://api.tryprofound.com` with the
 * version in the path, the API key travels in `X-API-Key`, categories are
 * `GET /v1/org/categories` (one row per category × organisation), and the
 * answers report is `POST /v1/prompts/answers` with offset pagination, one
 * row per prompt × model × run. The endpoint paths stay configurable per
 * connection (`config.endpoints`) so ops can follow a rename without a
 * deploy, and the connect step discovers the category list rather than
 * trusting the default.
 */

export const PROFOUND_DEFAULT_BASE = "https://api.tryprofound.com";

export interface ProfoundEndpoints {
  categories: string;
  answers: string;
  citations: string;
}

export const DEFAULT_ENDPOINTS: ProfoundEndpoints = {
  categories: "/v1/org/categories",
  answers: "/v1/prompts/answers",
  citations: "/v1/reports/citations",
};

/**
 * Paths tried, in order, when the configured category endpoint is not found.
 * A FastAPI 404 (`{"detail":"Not Found"}`) tells us the host is right and
 * only the path is stale.
 */
export const CATEGORY_PATH_CANDIDATES = ["/v1/org/categories", "/v1/categories", "/categories", "/v1/orgs", "/v1/organizations"];

/** Rows per answers page; Profound allows up to 50,000 but each row can carry a full response. */
export const ANSWERS_PAGE_SIZE = 2000;

export interface DiscoveryAttempt {
  url: string;
  status: number | null;
  detail: string;
}

export interface DiscoveryResult {
  categories: ProfoundCategory[];
  /** The base and path that answered, to persist on the connection. */
  baseUrl: string;
  path: string;
  attempts: DiscoveryAttempt[];
}

/** A discovery that found no category endpoint at all; `attempts` says what was tried. */
export class ProfoundDiscoveryError extends Error {
  constructor(public readonly attempts: DiscoveryAttempt[]) {
    super(`profound: no category endpoint answered (${attempts.length} tried)`);
    this.name = "ProfoundDiscoveryError";
  }
}

export interface ProfoundApiConfig {
  apiKey: string;
  baseUrl?: string;
  endpoints?: Partial<ProfoundEndpoints>;
  fetchImpl?: typeof fetch;
}

export class ProfoundApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`profound ${path}: ${message}`);
    this.name = "ProfoundApiError";
  }
}

export interface ProfoundCategory {
  id: string;
  name: string;
  /** Profound's own organisation / brand the category belongs to, when given. */
  organization?: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v === "true" || v === "yes" || v === 1 ? true : v === "false" || v === "no" || v === 0 ? false : null);

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** A name from either a bare string or an object with a `name` (Profound's v2 `model`, `organization`). */
function nameOf(v: unknown): string | null {
  if (typeof v === "string" || typeof v === "number") return str(v);
  if (v && typeof v === "object") return str(pick(v as Record<string, unknown>, "name", "display_name", "id"));
  return null;
}

/** The data array of a report, wherever the response put it. */
export function reportRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  if (!json || typeof json !== "object") return [];
  const o = json as Record<string, unknown>;
  for (const k of ["data", "rows", "results", "items", "answers", "citations", "categories"]) {
    const v = o[k];
    if (Array.isArray(v)) return v.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
    if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).rows)) return reportRows(v);
  }
  return [];
}

export function normalizeCategories(json: unknown): ProfoundCategory[] {
  return reportRows(json)
    .map((r) => ({ id: str(pick(r, "id", "category_id", "categoryId")) ?? "", name: str(pick(r, "name", "category", "category_name")) ?? "", organization: nameOf(pick(r, "organization", "organization_name", "brand")) }))
    .filter((c) => c.id && c.name);
}

function toIsoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1]!;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function citationsOf(v: unknown): ProfoundCitation[] {
  if (!Array.isArray(v)) return [];
  const out: ProfoundCitation[] = [];
  v.forEach((c, i) => {
    const url = typeof c === "string" ? c : c && typeof c === "object" ? str(pick(c as Record<string, unknown>, "url", "clean_url", "citation_url", "link", "source")) : null;
    if (!url || !/^https?:\/\//i.test(url)) return;
    const pos = c && typeof c === "object" ? num(pick(c as Record<string, unknown>, "position", "rank", "order")) : null;
    out.push({ url, domain: domainOf(url), position: pos ?? i + 1 });
  });
  return out;
}

/**
 * Whether the brand was mentioned. Profound's `mentions` lists the company
 * names in the answer and `asset` is the brand the category tracks, so a
 * mention is `asset ∈ mentions`; an explicit boolean column wins when present.
 */
function mentionedOf(r: Record<string, unknown>): boolean | null {
  const explicit = bool(pick(r, "brand_mentioned", "mentioned", "is_mentioned", "brand_present", "mention"));
  if (explicit !== null) return explicit;
  const mentions = pick(r, "mentions");
  if (!Array.isArray(mentions)) return null;
  const asset = nameOf(pick(r, "asset", "asset_name", "brand"));
  if (!asset) return mentions.length > 0 ? null : false;
  const a = asset.toLowerCase();
  return mentions.some((m) => (nameOf(m) ?? "").toLowerCase() === a);
}

/**
 * Answers report rows → ProfoundRecord. One row per prompt × model × run.
 * Rows without a prompt or a date are dropped; the caller reports how many.
 */
export function normalizeAnswerRows(rows: Record<string, unknown>[]): { records: ProfoundRecord[]; dropped: number } {
  const records: ProfoundRecord[] = [];
  let dropped = 0;
  for (const r of rows) {
    const prompt = str(pick(r, "prompt", "prompt_text", "query", "question"));
    const date = toIsoDate(pick(r, "date", "day", "created_at", "answered_at", "run_date"));
    if (!prompt || !date) {
      dropped++;
      continue;
    }
    const engine = normalizeEngine(nameOf(pick(r, "model", "platform", "engine", "assistant", "source")) ?? "unknown");
    const mentioned = mentionedOf(r);
    const visibility = num(pick(r, "visibility", "visibility_score", "share_of_voice", "sov"));
    const details = pick(r, "citation_details");
    const citations = citationsOf(Array.isArray(details) && details.length ? details : pick(r, "citations", "sources", "references", "urls"));
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "response") continue; // the full answer text is not ours to keep
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") raw[k] = String(v);
    }
    const model = nameOf(pick(r, "model"));
    if (model) raw.model = model;
    const mentions = pick(r, "mentions");
    if (Array.isArray(mentions)) raw.mentions = mentions.map((m) => nameOf(m) ?? "").filter(Boolean).join("|");
    const competitors = pick(r, "competitors_mentioned", "competitors", "brands_mentioned");
    if (Array.isArray(competitors)) raw.competitors_mentioned = competitors.map((c) => nameOf(c) ?? "").filter(Boolean).join("|");
    records.push({ prompt, engine, date, brandMentioned: mentioned, citations, visibility, raw });
  }
  return { records, dropped };
}

export interface ReportQuery {
  categoryId: string;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
  /** Page size; the client pages by offset until a short page. */
  limit?: number;
}

/** The v1 answers report wants date-times; a calendar day becomes its full UTC span. */
const dayStart = (d: string) => `${d}T00:00:00.000Z`;
const dayEnd = (d: string) => `${d}T23:59:59.999Z`;

/** Row fields we ask for; the answer text and sentiment themes are left out on purpose. */
const ANSWER_INCLUDE = { created_at: true, prompt: true, prompt_id: true, mentions: true, citations: true, citation_details: true, model: true, model_id: false, asset: true, region: true, topic: true, response: false, themes: false, prompt_type: false };

export class ProfoundApi {
  private readonly base: string;
  private readonly endpoints: ProfoundEndpoints;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ProfoundApiConfig) {
    this.base = (cfg.baseUrl ?? PROFOUND_DEFAULT_BASE).replace(/\/+$/, "");
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(cfg.endpoints ?? {}) };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.base;
  }

  /** Join without doubling a version segment: base `…/v1` + path `/v1/x` is `…/v1/x`. */
  static joinUrl(base: string, path: string): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    const b = /\/v\d+$/.test(base) && /^\/v\d+\//.test(p) ? base.replace(/\/v\d+$/, "") : base;
    return `${b}${p}`;
  }

  private async call<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string>; base?: string } = {}): Promise<T> {
    const url = new URL(ProfoundApi.joinUrl(init.base ?? this.base, path));
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      // API keys go in X-API-Key; Bearer is for OAuth access tokens and would be rejected.
      headers: { "x-api-key": this.cfg.apiKey, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const o = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
      const detail = o ? (str(o.message) ?? str(o.error) ?? (typeof o.detail === "string" ? o.detail : o.detail ? JSON.stringify(o.detail).slice(0, 200) : null)) : null;
      throw new ProfoundApiError(res.status, path, detail ?? text.slice(0, 200) ?? `status ${res.status}`);
    }
    return json as T;
  }

  async categories(): Promise<ProfoundCategory[]> {
    return normalizeCategories(await this.call(this.endpoints.categories));
  }

  /**
   * Find the category list when the configured path may be stale: the
   * configured path first, then the known alternatives, on the configured
   * base and on the base with the version segment toggled. A 401/403 stops
   * the search (the path exists; the key is the problem). A 404 moves on.
   */
  async discoverCategories(): Promise<DiscoveryResult> {
    const bases = [this.base];
    const m = /\/v\d+$/.exec(this.base);
    if (m) bases.push(this.base.slice(0, -m[0].length));
    const paths = [...new Set([this.endpoints.categories, ...CATEGORY_PATH_CANDIDATES])];
    const attempts: DiscoveryAttempt[] = [];
    const seen = new Set<string>();
    let empty: DiscoveryResult | null = null;
    for (const base of bases) {
      for (const path of paths) {
        const url = ProfoundApi.joinUrl(base, path);
        if (seen.has(url)) continue;
        seen.add(url);
        try {
          const categories = normalizeCategories(await this.call(path, { base }));
          attempts.push({ url, status: 200, detail: `${categories.length} categories` });
          const found = { categories, baseUrl: base, path, attempts };
          if (categories.length > 0) return found;
          empty ??= found;
        } catch (e) {
          if (e instanceof ProfoundApiError) {
            attempts.push({ url, status: e.status, detail: e.message.replace(/^profound [^:]*: /, "") });
            if (e.status === 401 || e.status === 403) throw e;
          } else {
            attempts.push({ url, status: null, detail: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
    if (empty) return empty;
    throw new ProfoundDiscoveryError(attempts);
  }

  /** Prove the key and category work by asking for one row of one day of the answers report. */
  async verifyReport(categoryId: string, endDate: string): Promise<{ rows: number }> {
    const start = new Date(dayStart(endDate));
    start.setUTCDate(start.getUTCDate() - 1);
    const body = { category_id: categoryId, start_date: start.toISOString(), end_date: dayEnd(endDate), pagination: { limit: 1, offset: 0 }, include: ANSWER_INCLUDE };
    const json = await this.call<Record<string, unknown>>(this.endpoints.answers, { method: "POST", body });
    return { rows: reportRows(json).length };
  }

  /** Answers with citations, one row per prompt × model × run, paged by offset until a short page. */
  async answers(q: ReportQuery): Promise<{ records: ProfoundRecord[]; dropped: number; pages: number }> {
    const all: Record<string, unknown>[] = [];
    const limit = q.limit ?? ANSWERS_PAGE_SIZE;
    let offset = 0;
    let pages = 0;
    for (;;) {
      const body = { category_id: q.categoryId, start_date: dayStart(q.startDate), end_date: dayEnd(q.endDate), pagination: { limit, offset }, include: ANSWER_INCLUDE };
      const json = await this.call<Record<string, unknown>>(this.endpoints.answers, { method: "POST", body });
      const rows = reportRows(json);
      all.push(...rows);
      pages++;
      const total = json && typeof json === "object" ? num((json.info as Record<string, unknown> | undefined)?.total_rows) : null;
      offset += rows.length;
      if (rows.length < limit || (total !== null && offset >= total) || pages >= 50) break;
    }
    const { records, dropped } = normalizeAnswerRows(all);
    return { records, dropped, pages };
  }
}

export const profoundApiConfigSchema = z.object({
  mode: z.literal("api"),
  categoryId: z.string().min(1),
  categoryName: z.string().optional(),
  baseUrl: z.string().url().optional(),
  endpoints: z.object({ categories: z.string().optional(), answers: z.string().optional(), citations: z.string().optional() }).partial().optional(),
  /** Days to backfill on the first sync. */
  backfillDays: z.number().int().min(1).max(400).default(90),
});
export type ProfoundApiConnectionConfig = z.infer<typeof profoundApiConfigSchema>;
