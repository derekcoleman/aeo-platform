import { z } from "zod";
import type { ProfoundCitation, ProfoundRecord } from "./csv";
import { domainOf, normalizeEngine } from "./csv";

/**
 * Profound REST client (Enterprise plan). Everything it returns is normalised
 * into ProfoundRecord — the same shape the CSV path produces — so one ingest
 * routine serves both.
 *
 * Profound's report API is a POST per report type with a category, a date
 * range, and the metrics/dimensions wanted. Field names in responses vary by
 * report and have changed across their versions, so the normaliser accepts
 * several spellings and the endpoint paths are configurable per connection
 * (`config.endpoints`), which lets ops adapt to an API change without a
 * deploy. Verify the defaults below against Profound's current reference
 * when connecting the first account; the connect step calls `categories()`
 * and surfaces exactly what came back.
 */

export const PROFOUND_DEFAULT_BASE = "https://api.tryprofound.com/v1";

export interface ProfoundEndpoints {
  categories: string;
  answers: string;
  citations: string;
}

export const DEFAULT_ENDPOINTS: ProfoundEndpoints = {
  categories: "/categories",
  answers: "/reports/answers",
  citations: "/reports/citations",
};

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
    .map((r) => ({ id: str(pick(r, "id", "category_id", "categoryId")) ?? "", name: str(pick(r, "name", "category", "category_name")) ?? "", organization: str(pick(r, "organization", "organization_name", "brand")) }))
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
    const url = typeof c === "string" ? c : c && typeof c === "object" ? str(pick(c as Record<string, unknown>, "url", "citation_url", "link", "source")) : null;
    if (!url || !/^https?:\/\//i.test(url)) return;
    const pos = c && typeof c === "object" ? num(pick(c as Record<string, unknown>, "position", "rank", "order")) : null;
    out.push({ url, domain: domainOf(url), position: pos ?? i + 1 });
  });
  return out;
}

/**
 * Answers report rows → ProfoundRecord. One row per prompt × platform × date.
 * Rows without a prompt or a date are dropped; the caller reports how many.
 */
export function normalizeAnswerRows(rows: Record<string, unknown>[]): { records: ProfoundRecord[]; dropped: number } {
  const records: ProfoundRecord[] = [];
  let dropped = 0;
  for (const r of rows) {
    const prompt = str(pick(r, "prompt", "prompt_text", "query", "question"));
    const date = toIsoDate(pick(r, "date", "day", "answered_at", "created_at", "run_date"));
    if (!prompt || !date) {
      dropped++;
      continue;
    }
    const engine = normalizeEngine(str(pick(r, "platform", "engine", "model", "assistant", "source")) ?? "unknown");
    const mentioned = bool(pick(r, "brand_mentioned", "mentioned", "is_mentioned", "brand_present", "mention"));
    const visibility = num(pick(r, "visibility", "visibility_score", "share_of_voice", "sov"));
    const citations = citationsOf(pick(r, "citations", "sources", "references", "urls"));
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") raw[k] = String(v);
    const competitors = pick(r, "competitors_mentioned", "competitors", "brands_mentioned");
    if (Array.isArray(competitors)) raw.competitors_mentioned = competitors.map((c) => (typeof c === "string" ? c : str(pick(c as Record<string, unknown>, "name", "brand")) ?? "")).filter(Boolean).join("|");
    records.push({ prompt, engine, date, brandMentioned: mentioned, citations, visibility, raw });
  }
  return { records, dropped };
}

export interface ReportQuery {
  categoryId: string;
  startDate: string;
  endDate: string;
  /** Page size; the client follows `next` / `cursor` when the response carries one. */
  limit?: number;
}

export class ProfoundApi {
  private readonly base: string;
  private readonly endpoints: ProfoundEndpoints;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ProfoundApiConfig) {
    this.base = (cfg.baseUrl ?? PROFOUND_DEFAULT_BASE).replace(/\/+$/, "");
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(cfg.endpoints ?? {}) };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(`${this.base}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json && typeof json === "object" ? (str((json as Record<string, unknown>).message) ?? str((json as Record<string, unknown>).error)) : null;
      throw new ProfoundApiError(res.status, path, msg ?? text.slice(0, 200) ?? `status ${res.status}`);
    }
    return json as T;
  }

  async categories(): Promise<ProfoundCategory[]> {
    return normalizeCategories(await this.call(this.endpoints.categories));
  }

  /** Answers with citations, one row per prompt × platform × date, paged until the response stops offering a cursor. */
  async answers(q: ReportQuery): Promise<{ records: ProfoundRecord[]; dropped: number; pages: number }> {
    const all: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: Record<string, unknown> = {
        category_id: q.categoryId,
        start_date: q.startDate,
        end_date: q.endDate,
        metrics: ["mentions", "citations", "visibility"],
        dimensions: ["prompt", "platform", "date"],
        include_citations: true,
        limit: q.limit ?? 500,
        ...(cursor ? { cursor } : {}),
      };
      const json = await this.call<Record<string, unknown>>(this.endpoints.answers, { method: "POST", body });
      all.push(...reportRows(json));
      pages++;
      const next = json && typeof json === "object" ? (str(json.next_cursor) ?? str(json.cursor) ?? str((json.pagination as Record<string, unknown> | undefined)?.next)) : null;
      cursor = next && next !== cursor ? next : null;
    } while (cursor && pages < 50);
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
