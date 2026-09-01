import type { ExternalMetricInput } from "../store";
import { googleJson } from "./oauth";

/**
 * Search Console Search Analytics. The only source of query-level demand
 * for *this* site: impressions, clicks, CTR, position per query and per
 * page. Data lags ~2–3 days and long-tail queries are anonymised, so a sync
 * always re-reads the last few days and never claims completeness.
 */

export const GSC_LAG_DAYS = 3;
const ROW_LIMIT = 25_000;

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryInput {
  /** `sc-domain:acme.com` or `https://acme.com/`. */
  property: string;
  startDate: string;
  endDate: string;
  dimensions: ("date" | "query" | "page")[];
  /** Restrict to pages under the site's content prefix (e.g. `/resources/`). */
  pathPrefix?: string | null;
  /** Restrict to a single page URL — for `dimensions: ["date","query"]` per published page. */
  pageEquals?: string | null;
}

interface SearchAnalyticsResponse { rows?: GscRow[] }

export async function queryGsc(fetchImpl: typeof fetch, accessToken: string, q: GscQueryInput): Promise<GscRow[]> {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(q.property)}/searchAnalytics/query`;
  const filters: { dimension: string; operator: string; expression: string }[] = [];
  if (q.pageEquals) filters.push({ dimension: "page", operator: "equals", expression: q.pageEquals });
  else if (q.pathPrefix && q.pathPrefix !== "/") filters.push({ dimension: "page", operator: "contains", expression: q.pathPrefix });
  const out: GscRow[] = [];
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const body = {
      startDate: q.startDate,
      endDate: q.endDate,
      dimensions: q.dimensions,
      rowLimit: ROW_LIMIT,
      startRow,
      dataState: "final",
      ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
    };
    const page = await googleJson<SearchAnalyticsResponse>(fetchImpl, accessToken, url, { body });
    const rows = page.rows ?? [];
    out.push(...rows);
    if (rows.length < ROW_LIMIT) break;
  }
  return out;
}

/** `contains` matching is substring, so a prefix of `/res` would also match `/resources-old`; tighten client-side. */
export function pageUnderPrefix(pageUrl: string, pathPrefix: string | null | undefined): boolean {
  if (!pathPrefix || pathPrefix === "/") return true;
  try {
    const p = new URL(pageUrl).pathname;
    const prefix = pathPrefix.replace(/\/+$/, "");
    return p === prefix || p.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

/** GSC rows → external_metrics rows. `surface` says which dimension set the row came from. */
export function normalizeGscRows(rows: GscRow[], dimensions: GscQueryInput["dimensions"], pathPrefix?: string | null): ExternalMetricInput[] {
  const out: ExternalMetricInput[] = [];
  const dateIdx = dimensions.indexOf("date");
  const queryIdx = dimensions.indexOf("query");
  const pageIdx = dimensions.indexOf("page");
  if (dateIdx < 0) throw new Error("normalizeGscRows requires a date dimension");
  for (const r of rows) {
    const date = r.keys[dateIdx];
    if (!date) continue;
    const page = pageIdx >= 0 ? r.keys[pageIdx] : undefined;
    if (page && !pageUnderPrefix(page, pathPrefix)) continue;
    const dimension: Record<string, string> = {};
    if (queryIdx >= 0 && r.keys[queryIdx]) dimension.query = r.keys[queryIdx]!;
    if (page) dimension.page = page;
    out.push({
      provider: "gsc",
      surface: queryIdx >= 0 && pageIdx >= 0 ? "gsc_query_page" : queryIdx >= 0 ? "gsc_query" : "gsc_page",
      dimension,
      date,
      metrics: { clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr, 4), position: round(r.position, 2) },
    });
  }
  return out;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface SitesListResponse { siteEntry?: { siteUrl: string; permissionLevel: string }[] }

/** Properties the granting account can read; the picker shows these. */
export async function listGscProperties(fetchImpl: typeof fetch, accessToken: string): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const res = await googleJson<SitesListResponse>(fetchImpl, accessToken, "https://searchconsole.googleapis.com/webmasters/v3/sites");
  return (res.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}
