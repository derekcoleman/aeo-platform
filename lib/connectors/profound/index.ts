import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentIdForUrl, isOwnedUrl, loadSiteOwnership, type SiteOwnership } from "@/lib/demand/store";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { isFeatureEnabled, upsertExternalMetrics, type ExternalMetricInput } from "../store";
import { ConnectorError, FeatureDisabledError, type Connector, type SyncInput, type SyncPageInput, type SyncPageResult, type SyncResult } from "../types";
import { ANSWERS_PAGE_SIZE, ProfoundApi, ProfoundApiError, profoundApiConfigSchema } from "./api";
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

/** Rows per statement: well under the 65,535-parameter limit at these column counts. */
const INSERT_CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Ingest parsed records for one site, in bulk and idempotently. Exported so
 * an upload route can call it outside the sync job.
 *
 * Everything lands in one transaction with multi-row statements: prompts are
 * upserted once each, then the (prompt, engine, day) tuples this batch
 * carries are deleted and re-inserted, so re-running a page after a crash
 * replaces its rows instead of doubling them. Snapshot ids are minted here so
 * citations can be built without depending on RETURNING order.
 */
export async function ingestProfoundRecords(
  own: SiteOwnership,
  conn: SyncInput<ProfoundConfig>["connection"] & { site_id: string },
  records: ProfoundRecord[],
  sql: postgres.Sql,
): Promise<Omit<ProfoundIngestResult, "skipped">> {
  const out = { questionsInserted: 0, questionsMatched: 0, snapshots: 0, citations: 0, ownedCitations: 0, metrics: 0 };
  if (records.length === 0) return out;

  return sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    // 1. Prompts → questions, one upsert per distinct prompt.
    const prompts = new Map<string, string>();
    for (const r of records) if (!prompts.has(normalizeQuestion(r.prompt))) prompts.set(normalizeQuestion(r.prompt), r.prompt);
    const questionIds = new Map<string, string>();
    for (const batch of chunks([...prompts.entries()], INSERT_CHUNK)) {
      const rows = batch.map(([normalized, text]) => ({ site_id: own.siteId, text, normalized, source: "profound", seed_term: text, depth: 1, locale: PROFOUND_LOCALE, device: PROFOUND_DEVICE, demand_score: 1, seen_count: 1 }));
      const res = await tx<{ id: string; normalized: string; inserted: boolean }[]>`
        insert into measure.questions ${tx(rows)}
        on conflict (site_id, normalized, locale, device) do update set last_seen_at = now()
        returning id, normalized, (xmax = 0) as inserted`;
      for (const q of res) {
        questionIds.set(q.normalized, q.id);
        if (q.inserted) out.questionsInserted += 1;
        else out.questionsMatched += 1;
      }
    }

    // 2. Snapshot rows with minted ids; the same tuples are removed first.
    type Snap = { id: string; qid: string; key: string; r: ProfoundRecord; fetchedAt: string };
    const snaps: Snap[] = [];
    for (const r of records) {
      const key = normalizeQuestion(r.prompt);
      const qid = questionIds.get(key);
      if (!qid) continue;
      snaps.push({ id: randomUUID(), qid, key, r, fetchedAt: `${r.date}T00:00:00.000Z` });
    }
    await tx`
      delete from measure.serp_snapshots s
      using unnest(${tx.array(snaps.map((x) => x.qid))}::uuid[], ${tx.array(snaps.map((x) => x.fetchedAt))}::timestamptz[], ${tx.array(snaps.map((x) => x.r.engine))}::text[]) as t(question_id, fetched_at, engine)
      where s.site_id = ${own.siteId} and s.provider = 'profound'
        and s.question_id = t.question_id and s.fetched_at = t.fetched_at and s.raw->>'engine' = t.engine`;
    for (const batch of chunks(snaps, INSERT_CHUNK)) {
      const rows = batch.map((x) => ({
        id: x.id,
        site_id: own.siteId,
        question_id: x.qid,
        provider: "profound",
        fetched_at: x.fetchedAt,
        locale: "us-en",
        device: PROFOUND_DEVICE,
        aio_triggered: true,
        aio_text: null,
        featured_snippet_url: null,
        organic_count: 0,
        cached: false,
        raw: tx.json({ source: "profound_csv", engine: x.r.engine, brandMentioned: x.r.brandMentioned, row: x.r.raw }),
        cost_usd: 0,
      }));
      await tx`insert into measure.serp_snapshots ${tx(rows)}`;
    }
    out.snapshots = snaps.length;

    // 3. Citations, with owned URLs resolved to content once per URL.
    const contentIds = new Map<string, string | null>();
    const cites: { site_id: string; serp_snapshot_id: string; surface: string; url: string; domain: string; position: number; is_owned: boolean; content_id: string | null; title: null; snippet: null }[] = [];
    const ownedPerSnap = new Map<string, number>();
    for (const x of snaps) {
      let owned = 0;
      for (const c of x.r.citations) {
        const isOwned = isOwnedUrl(c.url, own);
        let contentId: string | null = null;
        if (isOwned) {
          owned += 1;
          if (!contentIds.has(c.url)) contentIds.set(c.url, await contentIdForUrl(c.url, own, tx));
          contentId = contentIds.get(c.url) ?? null;
        }
        cites.push({ site_id: own.siteId, serp_snapshot_id: x.id, surface: "ai_overview", url: c.url, domain: c.domain, position: c.position, is_owned: isOwned, content_id: contentId, title: null, snippet: null });
      }
      ownedPerSnap.set(x.id, owned);
      out.ownedCitations += owned;
    }
    for (const batch of chunks(cites, INSERT_CHUNK * 2)) await tx`insert into measure.serp_citations ${tx(batch)}`;
    out.citations = cites.length;

    // 4. Visibility metrics, one row per prompt × engine × day.
    const metrics: ExternalMetricInput[] = snaps.map((x) => ({
      provider: "profound",
      surface: "profound_visibility",
      dimension: { engine: x.r.engine, prompt: x.key },
      date: x.r.date,
      metrics: {
        visibility: x.r.visibility,
        brand_mentioned: x.r.brandMentioned === null ? null : x.r.brandMentioned ? 1 : 0,
        citations: x.r.citations.length,
        owned_citations: ownedPerSnap.get(x.id) ?? 0,
      },
      questionId: x.qid,
    }));
    out.metrics = await upsertExternalMetrics(conn, metrics, tx);
    return out;
  });
}

/** Drop every Profound snapshot for a site in a day range (inclusive); a backfill replaces the range it covers. */
export async function deleteProfoundSnapshots(siteId: string, start: string, end: string, sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    delete from measure.serp_snapshots
    where site_id = ${siteId} and provider = 'profound'
      and fetched_at >= ${`${start}T00:00:00.000Z`} and fetched_at < ${`${addDays(end, 1)}T00:00:00.000Z`}
    returning id`;
  return rows.length;
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

  pagesSync(conn, kind) {
    return conn.config.mode === "api" && kind !== "upload";
  },

  /**
   * One page of the answers report. The first call of a run fixes the day
   * range (the configured depth for a backfill, the last cursor otherwise),
   * clears the site's Profound rows in that range, and walks it in windows
   * of BACKFILL_WINDOW_DAYS, each paged by offset. The page token carries
   * everything, so the job can memoise each call as its own step.
   */
  async syncPage(input, ctx): Promise<SyncPageResult> {
    const conn = input.connection;
    if (!(await isFeatureEnabled(conn.org_id, PROFOUND_FEATURE, ctx.sql))) throw new FeatureDisabledError("profound", PROFOUND_FEATURE);
    if (!conn.site_id) throw new ConnectorError("profound", "site_required", "profound: connection must be scoped to a site");
    if (conn.config.mode !== "api" || input.kind === "upload") throw new ConnectorError("profound", "invalid_config", "profound: paged sync is for API connections only");
    const cfg = profoundApiConfigSchema.parse(conn.config);
    const api = await profoundApiFor(conn, cfg, ctx);
    const today = ctx.now().toISOString().slice(0, 10);
    const through = typeof input.cursor?.through === "string" ? input.cursor.through : null;

    let page = answersPageSchema.safeParse(input.page).data ?? null;
    if (!page) {
      const resume = backfillResumeFrom(input.payload);
      const backfill = input.kind === "backfill" || !through;
      const rangeStart = resume ?? (backfill ? isoDaysAgo(ctx.now(), cfg.backfillDays) : through!);
      const w = backfillWindow(rangeStart, today);
      page = { rangeStart: w.start, rangeEnd: today, start: w.start, end: w.end, offset: 0 };
      const removed = await deleteProfoundSnapshots(conn.site_id, page.rangeStart, page.rangeEnd, ctx.sql);
      if (removed && ctx.env.NODE_ENV !== "test") console.info(`[profound] replaced ${removed} snapshots for ${conn.site_id} in ${page.rangeStart}..${page.rangeEnd}`);
    }

    const { records, dropped, rawCount, total } = await api.answersPage({ categoryId: cfg.categoryId, startDate: page.start, endDate: page.end, offset: page.offset });
    const own = await loadSiteOwnership(conn.site_id, ctx.sql);
    if (!own) throw new ConnectorError("profound", "site_not_found");
    const r = await ingestProfoundRecords(own, { ...conn, site_id: conn.site_id }, records, ctx.sql);

    const fetched = page.offset + rawCount;
    const windowDone = rawCount < ANSWERS_PAGE_SIZE || (total !== null && fetched >= total);
    let next: typeof page | null = null;
    if (!windowDone) next = { ...page, offset: fetched };
    else if (page.end < page.rangeEnd) {
      const w = backfillWindow(addDays(page.end, 1), page.rangeEnd);
      next = { ...page, start: w.start, end: w.end, offset: 0 };
    }
    return {
      documentsIngested: 0,
      metricsIngested: r.metrics,
      next,
      cursor: next ? null : { through: page.rangeEnd },
      detail: { ...r, mode: "api", rows: rawCount, dropped, window: { start: page.rangeStart, end: page.rangeEnd }, currentWindow: { start: page.start, end: page.end }, windowTotal: total },
    };
  },

  async sync(input, ctx): Promise<SyncResult> {
    const conn = input.connection;
    if (!(await isFeatureEnabled(conn.org_id, PROFOUND_FEATURE, ctx.sql))) throw new FeatureDisabledError("profound", PROFOUND_FEATURE);
    if (!conn.site_id) throw new ConnectorError("profound", "site_required", "profound: connection must be scoped to a site");
    if (conn.config.mode === "api" && input.kind !== "upload") {
      // Same work as the paged path, walked here for callers without a job runner.
      const totals = { metrics: 0, rows: 0, snapshots: 0, pages: 0 };
      let page: SyncPageInput<ProfoundConfig>["page"] = null;
      let detail: Record<string, unknown> = {};
      for (;;) {
        const r = await this.syncPage!({ ...input, page }, ctx);
        totals.metrics += r.metricsIngested;
        totals.rows += Number(r.detail?.rows ?? 0);
        totals.snapshots += Number(r.detail?.snapshots ?? 0);
        totals.pages += 1;
        detail = r.detail ?? {};
        if (!r.next) return { documentsIngested: 0, metricsIngested: totals.metrics, cursor: r.cursor, detail: { ...detail, rows: totals.rows, snapshots: totals.snapshots, pages: totals.pages } };
        page = r.next;
      }
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

/** The page token of a Profound API sync: the whole range, the window inside it, and the offset within the window. */
const answersPageSchema = z.object({
  rangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  offset: z.number().int().min(0),
});

/** The `from` a resumed backfill carries in its payload; anything else means start from the configured depth. */
export function backfillResumeFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const from = (payload as { from?: unknown }).from;
  return typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
}
