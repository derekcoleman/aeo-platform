import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { citationRole, contentIdForUrl, isOwnedUrl, loadSiteOwnership, type SiteOwnership } from "@/lib/demand/store";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { answerEngineSlug, answerSurface } from "@/lib/answers/engines";
import { loadSourceRoleContext, type SourceRole } from "@/lib/measure/source-roles";
import { isFeatureEnabled } from "../store";
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
 * measure.v_native_aio, which never holds a Profound row. Their data is
 * mapped into our schema rather than mirrored: prompts → measure.questions
 * (source 'profound'), answers → measure.serp_snapshots with provider
 * 'profound', collection_method 'third_party' and Profound's engine (an AI
 * Overview flag only on Google AI Overview rows), citations →
 * measure.serp_citations on that engine's surface (ai_overview, ai_mode or
 * llm_answer; each with its source role, so a rival and a review site are
 * told apart here too), and visibility → measure.external_metrics (surface
 * 'profound_visibility').
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
 * citations can be built without depending on RETURNING order. `syncRun`
 * stamps every snapshot and metrics row an API run writes, so the run's last
 * page can sweep away what it no longer reported (sweepProfoundRun).
 */
export async function ingestProfoundRecords(
  own: SiteOwnership,
  conn: SyncInput<ProfoundConfig>["connection"] & { site_id: string },
  records: ProfoundRecord[],
  sql: postgres.Sql,
  opts: { syncRun?: string | null } = {},
): Promise<Omit<ProfoundIngestResult, "skipped">> {
  const syncRun = opts.syncRun ?? null;
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

    // 2. Snapshot rows with minted ids. Profound reports several answers per
    // prompt × engine × day (samples, regions), so identity is the row's own
    // content hash: the rows this batch carries are removed by hash and
    // re-inserted, which makes a replayed page a no-op and leaves rows from
    // other pages of the same day alone.
    type Snap = { id: string; qid: string; key: string; r: ProfoundRecord; fetchedAt: string; hash: string };
    const snaps: Snap[] = [];
    for (const r of records) {
      const key = normalizeQuestion(r.prompt);
      const qid = questionIds.get(key);
      if (!qid) continue;
      snaps.push({ id: randomUUID(), qid, key, r, fetchedAt: `${r.date}T00:00:00.000Z`, hash: profoundRowHash(r) });
    }
    await tx`
      delete from measure.serp_snapshots s
      using unnest(${tx.array(snaps.map((x) => x.qid))}::uuid[], ${tx.array(snaps.map((x) => x.fetchedAt))}::timestamptz[], ${tx.array(snaps.map((x) => x.hash))}::text[]) as t(question_id, fetched_at, row_hash)
      where s.site_id = ${own.siteId} and s.provider = 'profound'
        and s.question_id = t.question_id and s.fetched_at = t.fetched_at and s.raw->>'row_hash' = t.row_hash`;
    for (const batch of chunks(snaps, INSERT_CHUNK)) {
      const rows = batch.map((x) => ({
        id: x.id,
        site_id: own.siteId,
        question_id: x.qid,
        provider: "profound",
        engine: answerEngineSlug(x.r.engine),
        collection_method: "third_party",
        fetched_at: x.fetchedAt,
        locale: "us-en",
        device: PROFOUND_DEVICE,
        // Only Google's AI Overview is an AI Overview; another engine's answer has no such flag.
        aio_triggered: answerEngineSlug(x.r.engine) === "google_aio" ? true : null,
        aio_text: null,
        featured_snippet_url: null,
        organic_count: 0,
        cached: false,
        raw: tx.json({ source: "profound_csv", engine: x.r.engine, brandMentioned: x.r.brandMentioned, visibility: x.r.visibility, row_hash: x.hash, sync_run: syncRun, row: x.r.raw }),
        cost_usd: 0,
      }));
      await tx`insert into measure.serp_snapshots ${tx(rows)}`;
    }
    out.snapshots = snaps.length;

    // 3. Citations, with owned URLs resolved to content once per URL and
    // every cited site given its role (competitor, review site, forum…),
    // read here so a competitor named or removed since `own` was loaded counts.
    const roles = await loadSourceRoleContext(own.siteId, own.orgId, tx, own.domains);
    const contentIds = new Map<string, string | null>();
    const cites: { site_id: string; serp_snapshot_id: string; surface: string; url: string; domain: string; position: number; is_owned: boolean; content_id: string | null; title: null; snippet: null; source_role: SourceRole; entity_id: string | null }[] = [];
    for (const x of snaps) {
      const surface = answerSurface(answerEngineSlug(x.r.engine));
      for (const c of x.r.citations) {
        const isOwned = isOwnedUrl(c.url, own);
        let contentId: string | null = null;
        if (isOwned) {
          out.ownedCitations += 1;
          if (!contentIds.has(c.url)) contentIds.set(c.url, await contentIdForUrl(c.url, own, tx));
          contentId = contentIds.get(c.url) ?? null;
        }
        const source = citationRole(c.url, c.domain, own, roles);
        cites.push({ site_id: own.siteId, serp_snapshot_id: x.id, surface, url: c.url, domain: c.domain, position: c.position, is_owned: isOwned, content_id: contentId, title: null, snippet: null, source_role: source.role, entity_id: source.entityId });
      }
    }
    for (const batch of chunks(cites, INSERT_CHUNK * 2)) await tx`insert into measure.serp_citations ${tx(batch)}`;
    out.citations = cites.length;

    // 4. Daily visibility metrics, one row per prompt × engine × day, computed
    // from every snapshot now stored for the groups this batch touched. The
    // aggregate is the full picture whichever page a sample arrived on, and
    // recomputing it is idempotent.
    const groups = new Map<string, ProfoundMetricGroup>();
    for (const x of snaps) groups.set(`${x.qid}|${x.fetchedAt}|${x.r.engine}`, { qid: x.qid, fetchedAt: x.fetchedAt, engine: x.r.engine });
    out.metrics = await aggregateProfoundMetrics(own.siteId, conn, [...groups.values()], syncRun, tx);
    return out;
  });
}

/** One daily metrics row's key: a prompt, an engine and the day its samples were taken. */
export interface ProfoundMetricGroup {
  qid: string;
  fetchedAt: string;
  engine: string;
}

/** (Re)compute the daily metrics rows of these groups from every snapshot stored for them; returns rows written. */
async function aggregateProfoundMetrics(siteId: string, conn: { id: string; org_id: string }, g: ProfoundMetricGroup[], syncRun: string | null, tx: postgres.Sql): Promise<number> {
  if (g.length === 0) return 0;
  const written = await tx<{ id: string }[]>`
    insert into measure.external_metrics (org_id, site_id, connection_id, provider, surface, dimension, date, metrics, question_id, fetched_at)
    select ${conn.org_id}, ${siteId}, ${conn.id}, 'profound', 'profound_visibility',
           jsonb_build_object('engine', t.engine, 'prompt', q.normalized),
           (s.fetched_at at time zone 'UTC')::date,
           jsonb_build_object(
             'visibility', avg((s.raw->>'visibility')::numeric),
             'brand_mentioned', max(case when (s.raw->>'brandMentioned')::boolean then 1 when s.raw->>'brandMentioned' is not null then 0 end),
             'citations', count(c.id),
             'owned_citations', count(c.id) filter (where c.is_owned),
             'samples', count(distinct s.id),
             'sync_run', ${syncRun}::text),
           s.question_id, now()
    from unnest(${tx.array(g.map((x) => x.qid))}::uuid[], ${tx.array(g.map((x) => x.fetchedAt))}::timestamptz[], ${tx.array(g.map((x) => x.engine))}::text[]) as t(question_id, fetched_at, engine)
    join measure.serp_snapshots s on s.question_id = t.question_id and s.fetched_at = t.fetched_at and s.raw->>'engine' = t.engine
    join measure.questions q on q.id = s.question_id
    left join measure.serp_citations c on c.serp_snapshot_id = s.id
    where s.site_id = ${siteId} and s.provider = 'profound'
    group by s.question_id, q.normalized, s.fetched_at, t.engine
    on conflict (site_id, provider, surface, dimension, date) do update
      set metrics = excluded.metrics, connection_id = excluded.connection_id,
          question_id = excluded.question_id, fetched_at = now()
    returning id`;
  return written.length;
}

/**
 * The end of an API run: everything Profound reported for the range is now
 * stored and stamped with the run, so what is left in the range without the
 * stamp is what Profound no longer reports (or a duplicate an earlier killed
 * run left behind) and goes. Days whose samples changed get their metrics
 * rebuilt from what remains; a metrics row no snapshot backs any more goes
 * too. Until this runs, the previous data stays in place: a run that fails
 * on a later page leaves the site's Profound history whole rather than half
 * deleted, which is what clearing the range up front did.
 */
export async function sweepProfoundRun(
  own: Pick<SiteOwnership, "siteId">,
  conn: { id: string; org_id: string },
  range: { start: string; end: string },
  syncRun: string,
  sql: postgres.Sql,
): Promise<{ snapshots: number; metrics: number }> {
  return sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    const gone = await tx<{ question_id: string; fetched_at: Date | string; engine: string | null }[]>`
      delete from measure.serp_snapshots
      where site_id = ${own.siteId} and provider = 'profound'
        and fetched_at >= ${`${range.start}T00:00:00.000Z`} and fetched_at < ${`${addDays(range.end, 1)}T00:00:00.000Z`}
        and raw->>'sync_run' is distinct from ${syncRun}
      returning question_id, fetched_at, raw->>'engine' as engine`;
    const groups = new Map<string, ProfoundMetricGroup>();
    for (const r of gone) {
      if (!r.engine) continue;
      const fetchedAt = new Date(r.fetched_at).toISOString();
      groups.set(`${r.question_id}|${fetchedAt}|${r.engine}`, { qid: r.question_id, fetchedAt, engine: r.engine });
    }
    await aggregateProfoundMetrics(own.siteId, conn, [...groups.values()], syncRun, tx);
    const metrics = await tx<{ id: string }[]>`
      delete from measure.external_metrics
      where site_id = ${own.siteId} and provider = 'profound' and surface = 'profound_visibility'
        and date >= ${range.start} and date <= ${range.end}
        and metrics->>'sync_run' is distinct from ${syncRun}
      returning id`;
    return { snapshots: gone.length, metrics: metrics.length };
  });
}

/** A record's identity across syncs: every scalar Profound gave us, so two samples of one prompt/engine/day stay distinct rows. */
export function profoundRowHash(r: ProfoundRecord): string {
  const scalars = Object.keys(r.raw).sort().map((k) => `${k}=${r.raw[k]}`);
  return createHash("sha256").update([r.prompt, r.engine, r.date, r.brandMentioned ?? "", r.visibility ?? "", r.citations.map((c) => c.url).join(","), ...scalars].join("\u0000")).digest("hex").slice(0, 32);
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
   * range (the configured depth for a backfill, the last cursor otherwise)
   * and mints the run's marker, then walks the range in windows of
   * BACKFILL_WINDOW_DAYS, each paged by offset. Every row a page writes is
   * stamped with the marker; the last page sweeps the range for rows without
   * it. Nothing is deleted before Profound has answered, so a run that fails
   * part way keeps the old rows. The page token carries everything, so the
   * job can memoise each call as its own step.
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
      page = { rangeStart: w.start, rangeEnd: today, start: w.start, end: w.end, offset: 0, run: randomUUID() };
    }

    const { records, dropped, rawCount, total } = await api.answersPage({ categoryId: cfg.categoryId, startDate: page.start, endDate: page.end, offset: page.offset });
    const own = await loadSiteOwnership(conn.site_id, ctx.sql);
    if (!own) throw new ConnectorError("profound", "site_not_found");
    const r = await ingestProfoundRecords(own, { ...conn, site_id: conn.site_id }, records, ctx.sql, { syncRun: page.run ?? null });

    const fetched = page.offset + rawCount;
    const windowDone = rawCount < ANSWERS_PAGE_SIZE || (total !== null && fetched >= total);
    let next: typeof page | null = null;
    if (!windowDone) next = { ...page, offset: fetched };
    else if (page.end < page.rangeEnd) {
      const w = backfillWindow(addDays(page.end, 1), page.rangeEnd);
      next = { ...page, start: w.start, end: w.end, offset: 0 };
    }
    // A token minted before run markers existed cleared its range up front and has nothing to sweep.
    const swept = !next && page.run ? await sweepProfoundRun(own, conn, { start: page.rangeStart, end: page.rangeEnd }, page.run, ctx.sql) : null;
    if (swept?.snapshots && ctx.env.NODE_ENV !== "test") console.info(`[profound] swept ${swept.snapshots} snapshots no longer reported for ${conn.site_id} in ${page.rangeStart}..${page.rangeEnd}`);
    return {
      documentsIngested: 0,
      metricsIngested: r.metrics,
      next,
      cursor: next ? null : { through: page.rangeEnd },
      detail: { ...r, mode: "api", rows: rawCount, dropped, window: { start: page.rangeStart, end: page.rangeEnd }, currentWindow: { start: page.start, end: page.end }, windowTotal: total, ...(swept ? { swept } : {}) },
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

/** The page token of a Profound API sync: the whole range, the window inside it, the offset within the window, and the run's marker. */
const answersPageSchema = z.object({
  rangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  offset: z.number().int().min(0),
  run: z.string().min(8).max(64).optional(),
});

/** The `from` a resumed backfill carries in its payload; anything else means start from the configured depth. */
export function backfillResumeFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const from = (payload as { from?: unknown }).from;
  return typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
}
