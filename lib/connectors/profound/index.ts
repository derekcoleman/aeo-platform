import { z } from "zod";
import { loadSiteOwnership, recordSnapshot, type SiteOwnership } from "@/lib/demand/store";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { isFeatureEnabled, upsertExternalMetrics, type ExternalMetricInput } from "../store";
import { ConnectorError, FeatureDisabledError, type Connector, type SyncInput, type SyncResult } from "../types";
import { ProfoundApi, ProfoundApiError, profoundApiConfigSchema } from "./api";
import { parseProfoundCsv, type ProfoundRecord } from "./csv";
import type postgres from "postgres";

export * from "./csv";
export * from "./api";

/**
 * Profound connector — CSV path first.
 *
 * Profound is enrichment, never a dependency: the whole connector sits behind
 * the `connector:profound` org feature flag, and native metrics read only
 * NATIVE_PROVIDERS. Their data is mapped into our schema rather than
 * mirrored: prompts → measure.questions (source 'profound'), citations →
 * measure.serp_citations under a snapshot with provider 'profound', and
 * visibility → measure.external_metrics (surface 'profound_visibility').
 * Every derived row carries the provider so the UI can attribute it.
 */

export const PROFOUND_FEATURE = "connector:profound";
export const PROFOUND_LOCALE = "us-en";
export const PROFOUND_DEVICE = "desktop";

export interface ProfoundConfig {
  /** Profound plan tier as the customer reports it — decides which ingest paths the UI offers. */
  plan?: "growth" | "enterprise" | "unknown";
  /** "api" connections sync on the daily schedule; CSV connections only accept uploads. */
  mode?: "csv" | "api";
  categoryId?: string;
  categoryName?: string;
  baseUrl?: string;
  endpoints?: { categories?: string; answers?: string; citations?: string };
  backfillDays?: number;
  /** Upload retention: raw snapshot JSON is kept; nothing else to trim. */
  notes?: string;
}

export const profoundUploadPayload = z.object({
  csv: z.string().min(1),
  filename: z.string().optional(),
  /** Deduplicate against a prior upload of the same file. */
  sha256: z.string().optional(),
});
export type ProfoundUploadPayload = z.infer<typeof profoundUploadPayload>;

export interface ProfoundIngestResult {
  questionsInserted: number;
  questionsMatched: number;
  snapshots: number;
  citations: number;
  ownedCitations: number;
  metrics: number;
  skipped: { line: number; reason: string }[];
}

async function upsertProfoundQuestion(siteId: string, prompt: string, sql: postgres.Sql): Promise<{ id: string; inserted: boolean }> {
  const normalized = normalizeQuestion(prompt);
  const [row] = await sql<{ id: string; inserted: boolean }[]>`
    insert into measure.questions (site_id, text, normalized, source, seed_term, depth, locale, device, demand_score, seen_count)
    values (${siteId}, ${prompt}, ${normalized}, 'profound', ${prompt}, 1, ${PROFOUND_LOCALE}, ${PROFOUND_DEVICE}, 1, 1)
    on conflict (site_id, normalized, locale, device) do update set last_seen_at = now()
    returning id, (xmax = 0) as inserted`;
  return row!;
}

/** Ingest parsed records for one site. Exported so an upload route can call it outside the sync job. */
export async function ingestProfoundRecords(
  own: SiteOwnership,
  conn: SyncInput<ProfoundConfig>["connection"] & { site_id: string },
  records: ProfoundRecord[],
  sql: postgres.Sql,
): Promise<Omit<ProfoundIngestResult, "skipped">> {
  const out = { questionsInserted: 0, questionsMatched: 0, snapshots: 0, citations: 0, ownedCitations: 0, metrics: 0 };
  const questionIds = new Map<string, string>();
  const metrics: ExternalMetricInput[] = [];

  for (const r of records) {
    const key = normalizeQuestion(r.prompt);
    let qid = questionIds.get(key);
    if (!qid) {
      const q = await upsertProfoundQuestion(own.siteId, r.prompt, sql);
      qid = q.id;
      questionIds.set(key, qid);
      if (q.inserted) out.questionsInserted += 1;
      else out.questionsMatched += 1;
    }

    // One snapshot per record: what the engine answered on that day, with
    // its citations. Organic/PAA/featured snippet are not Profound concepts.
    const rec = await recordSnapshot(
      own,
      qid,
      {
        provider: "profound",
        query: r.prompt,
        locale: { country: "us", language: "en" },
        device: PROFOUND_DEVICE,
        fetchedAt: `${r.date}T00:00:00.000Z`,
        organic: [],
        paa: [],
        featuredSnippet: null,
        aiOverview: { triggered: true, text: null, references: r.citations.map((c) => ({ position: c.position, url: c.url, domain: c.domain })) },
        raw: { source: "profound_csv", engine: r.engine, brandMentioned: r.brandMentioned, row: r.raw },
        costUsd: 0,
        cached: false,
      },
      sql,
    );
    out.snapshots += 1;
    out.citations += rec.citations;
    out.ownedCitations += rec.ownedCitations;

    metrics.push({
      provider: "profound",
      surface: "profound_visibility",
      dimension: { engine: r.engine, prompt: key },
      date: r.date,
      metrics: {
        visibility: r.visibility,
        brand_mentioned: r.brandMentioned === null ? null : r.brandMentioned ? 1 : 0,
        citations: r.citations.length,
        owned_citations: rec.ownedCitations,
      },
      questionId: qid,
    });
  }

  out.metrics = await upsertExternalMetrics(conn, metrics, sql);
  return out;
}

export const profoundConnector: Connector<ProfoundConfig> = {
  provider: "profound",

  async validate(conn, ctx) {
    if (!(await isFeatureEnabled(conn.org_id, PROFOUND_FEATURE, ctx.sql))) throw new FeatureDisabledError("profound", PROFOUND_FEATURE);
    if (!conn.site_id) throw new ConnectorError("profound", "site_required", "profound: connection must be scoped to a site");
    if (conn.config.mode === "api") {
      const cfg = profoundApiConfigSchema.parse(conn.config);
      const api = await profoundApiFor(conn, cfg, ctx);
      let cats: { id: string }[] | null = null;
      try {
        cats = await api.categories();
      } catch (e) {
        // The list endpoint moved or is not on this plan; the report itself is the proof.
        if (!(e instanceof ProfoundApiError && e.status === 404)) throw e;
        await api.verifyReport(cfg.categoryId, ctx.now().toISOString().slice(0, 10));
      }
      if (cats && !cats.some((c) => c.id === cfg.categoryId)) throw new ConnectorError("profound", "category_not_found", `profound: category ${cfg.categoryId} is not visible to this key (${cats.length} categories returned)`);
    }
  },

  async sync(input, ctx): Promise<SyncResult> {
    const conn = input.connection;
    if (!(await isFeatureEnabled(conn.org_id, PROFOUND_FEATURE, ctx.sql))) throw new FeatureDisabledError("profound", PROFOUND_FEATURE);
    if (!conn.site_id) throw new ConnectorError("profound", "site_required", "profound: connection must be scoped to a site");
    if (conn.config.mode === "api" && input.kind !== "upload") {
      const cfg = profoundApiConfigSchema.parse(conn.config);
      const api = await profoundApiFor(conn, cfg, ctx);
      const today = ctx.now().toISOString().slice(0, 10);
      const through = typeof input.cursor?.through === "string" ? input.cursor.through : null;
      // A backfill is walked in windows so no single run outlives the
      // platform's function limit: each window is one run with its own
      // cursor, and `detail.next` tells the job to queue the following one.
      // An incremental sync covers the gap since the last cursor in one go.
      const resume = backfillResumeFrom(input.payload);
      const backfill = input.kind === "backfill" || !through;
      const start = resume ?? (backfill ? isoDaysAgo(ctx.now(), cfg.backfillDays) : through!);
      const { end, next } = backfill ? backfillWindow(start, today) : { end: today, next: null };
      const { records, dropped, pages } = await api.answers({ categoryId: cfg.categoryId, startDate: start, endDate: end });
      const own = await loadSiteOwnership(conn.site_id, ctx.sql);
      if (!own) throw new ConnectorError("profound", "site_not_found");
      const r = records.length ? await ingestProfoundRecords(own, { ...conn, site_id: conn.site_id }, records, ctx.sql) : { questionsInserted: 0, questionsMatched: 0, snapshots: 0, citations: 0, ownedCitations: 0, metrics: 0 };
      return {
        documentsIngested: 0,
        metricsIngested: r.metrics,
        cursor: { through: end },
        detail: { ...r, mode: "api", rows: records.length, dropped, pages, window: { start, end }, next: next ? { from: next } : null },
      };
    }
    if (input.kind !== "upload") {
      // A scheduled sync on a CSV-only connection is a no-op, not a failure.
      return { documentsIngested: 0, metricsIngested: 0, cursor: input.cursor, detail: { skipped: `kind ${input.kind} unsupported on csv path` } };
    }
    const payload = profoundUploadPayload.parse(input.payload);
    const parsed = parseProfoundCsv(payload.csv); // fail on a bad file before touching the database
    const own = await loadSiteOwnership(conn.site_id, ctx.sql);
    if (!own) throw new ConnectorError("profound", "site_not_found");

    const r = await ingestProfoundRecords(own, { ...conn, site_id: conn.site_id }, parsed.records, ctx.sql);
    const lastDate = parsed.records.reduce((m, x) => (x.date > m ? x.date : m), (input.cursor?.through as string | undefined) ?? "");
    return {
      documentsIngested: 0,
      metricsIngested: r.metrics,
      cursor: { through: lastDate || null, lastFile: payload.filename ?? null, lastSha256: payload.sha256 ?? null },
      detail: { ...r, rows: parsed.records.length, skipped: parsed.skipped.slice(0, 50), columns: parsed.columns },
    };
  },
};


async function profoundApiFor(conn: SyncInput<ProfoundConfig>["connection"], cfg: { baseUrl?: string; endpoints?: Record<string, string | undefined> }, ctx: { secrets: { get(ref: string): Promise<string | null> }; fetchImpl: typeof fetch }): Promise<ProfoundApi> {
  if (!conn.secret_ref) throw new ConnectorError("profound", "no_api_key", "profound: connection has no API key");
  const apiKey = await ctx.secrets.get(conn.secret_ref);
  if (!apiKey) throw new ConnectorError("profound", "api_key_missing", "profound: API key not found in Vault");
  return new ProfoundApi({ apiKey, baseUrl: cfg.baseUrl, endpoints: cfg.endpoints as never, fetchImpl: ctx.fetchImpl });
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Days of answers one backfill run fetches. A 90-day category in one call can outlive the function limit. */
export const BACKFILL_WINDOW_DAYS = 30;

/**
 * The window a backfill run covers starting at `from` (inclusive), and where
 * the next run starts, or null when this window reaches `today`.
 */
export function backfillWindow(from: string, today: string, days = BACKFILL_WINDOW_DAYS): { start: string; end: string; next: string | null } {
  const start = from > today ? today : from;
  const last = addDays(start, days - 1);
  const end = last < today ? last : today;
  return { start, end, next: end < today ? addDays(end, 1) : null };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The `from` a chained backfill run carries in its payload; anything else means start from the configured depth. */
export function backfillResumeFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const from = (payload as { from?: unknown }).from;
  return typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
}
