import type { ExternalMetricInput } from "../store";
import { googleJson } from "./oauth";

/**
 * GA4 Data API: sessions and conversions arriving from AI answer engines.
 * The referrer list is the attribution triangle's third leg; keep it a
 * data table so a new engine is one line, and store the raw source so a
 * missed one can be backfilled.
 */

export const AI_REFERRER_SOURCES: Record<string, string> = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "perplexity.ai": "perplexity",
  "www.perplexity.ai": "perplexity",
  "gemini.google.com": "gemini",
  "bard.google.com": "gemini",
  "copilot.microsoft.com": "copilot",
  "bing.com/chat": "copilot",
  "claude.ai": "claude",
  "you.com": "you",
  "search.brave.com": "brave",
  "duckduckgo.com/aichat": "duckduckgo",
};

export function engineForSource(source: string): string | null {
  const s = source.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (AI_REFERRER_SOURCES[s]) return AI_REFERRER_SOURCES[s]!;
  for (const [host, engine] of Object.entries(AI_REFERRER_SOURCES)) if (s.endsWith(`.${host}`) || s.startsWith(`${host}/`)) return engine;
  return null;
}

export interface Ga4Row {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

interface RunReportResponse { rows?: Ga4Row[]; rowCount?: number }

export interface Ga4QueryInput {
  propertyId: string; // numeric, without the `properties/` prefix
  startDate: string;
  endDate: string;
  pathPrefix?: string | null;
}

export const GA4_DIMENSIONS = ["date", "sessionSource", "landingPagePlusQueryString"] as const;
export const GA4_METRICS = ["sessions", "engagedSessions", "conversions", "totalUsers"] as const;

/** Pull AI-referral sessions per landing page per day. One report per sync; GA4 limits are generous at this shape. */
export async function queryGa4AiReferrals(fetchImpl: typeof fetch, accessToken: string, q: Ga4QueryInput): Promise<Ga4Row[]> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(q.propertyId)}:runReport`;
  const sourceFilter = {
    orGroup: {
      expressions: Object.keys(AI_REFERRER_SOURCES).map((host) => ({
        filter: { fieldName: "sessionSource", stringFilter: { matchType: "CONTAINS", value: host.split("/")[0], caseSensitive: false } },
      })),
    },
  };
  const filters: unknown[] = [sourceFilter];
  if (q.pathPrefix && q.pathPrefix !== "/") {
    filters.push({ filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "BEGINS_WITH", value: q.pathPrefix.replace(/\/+$/, "") } } });
  }
  const out: Ga4Row[] = [];
  const limit = 10_000;
  for (let offset = 0; ; offset += limit) {
    const body = {
      dateRanges: [{ startDate: q.startDate, endDate: q.endDate }],
      dimensions: GA4_DIMENSIONS.map((name) => ({ name })),
      metrics: GA4_METRICS.map((name) => ({ name })),
      dimensionFilter: filters.length === 1 ? filters[0] : { andGroup: { expressions: filters } },
      limit,
      offset,
      keepEmptyRows: false,
    };
    const page = await googleJson<RunReportResponse>(fetchImpl, accessToken, url, { body });
    const rows = page.rows ?? [];
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

/** `20260901` → `2026-09-01`. */
export function ga4Date(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

export function normalizeGa4Rows(rows: Ga4Row[]): ExternalMetricInput[] {
  const out: ExternalMetricInput[] = [];
  for (const r of rows) {
    const [date, source, landing] = r.dimensionValues.map((v) => v.value);
    if (!date || !source) continue;
    const engine = engineForSource(source);
    if (!engine) continue; // CONTAINS is loose; keep only sources we can name
    const metrics: Record<string, number> = {};
    GA4_METRICS.forEach((name, i) => (metrics[name] = Number(r.metricValues[i]?.value ?? 0)));
    out.push({
      provider: "ga4",
      surface: "ga4_referral",
      dimension: { engine, source, landingPage: landing?.split("?")[0] ?? "" },
      date: ga4Date(date),
      metrics,
    });
  }
  return out;
}

interface AccountSummariesResponse { accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName?: string }[] }[]; nextPageToken?: string }

export async function listGa4Properties(fetchImpl: typeof fetch, accessToken: string): Promise<{ propertyId: string; displayName: string }[]> {
  const out: { propertyId: string; displayName: string }[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await googleJson<AccountSummariesResponse>(fetchImpl, accessToken, url.toString());
    for (const a of res.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        out.push({ propertyId: p.property.replace(/^properties\//, ""), displayName: `${a.displayName ?? ""} / ${p.displayName ?? p.property}`.replace(/^ \/ /, "") });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}
