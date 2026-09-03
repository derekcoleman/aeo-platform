import { z } from "zod";
import { loadSiteOwnership, recordSnapshot, type SiteOwnership } from "@/lib/demand/store";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { isFeatureEnabled, upsertExternalMetrics, type ExternalMetricInput } from "../store";
import { ConnectorError, FeatureDisabledError, type Connector, type SyncInput, type SyncResult } from "../types";
import { parseProfoundCsv, type ProfoundRecord } from "./csv";
import type postgres from "postgres";

export * from "./csv";

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
  },

  async sync(input, ctx): Promise<SyncResult> {
    const conn = input.connection;
    if (!(await isFeatureEnabled(conn.org_id, PROFOUND_FEATURE, ctx.sql))) throw new FeatureDisabledError("profound", PROFOUND_FEATURE);
    if (!conn.site_id) throw new ConnectorError("profound", "site_required", "profound: connection must be scoped to a site");
    if (input.kind !== "upload") {
      // API/MCP paths land later; a scheduled sync on a CSV-only connection is a no-op, not a failure.
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

