import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * How the measurement numbers are computed, versioned. When a change moves a
 * number a customer has already seen, the version moves, the change is
 * listed here, and computeRestatement (lib/app/restatement.ts) records the
 * old and the new value of each affected metric per site, so the pages that
 * show those numbers can say what changed and why instead of the customer
 * finding a silent drop.
 */
export const METHODOLOGY_VERSION = "2026-10-r1";

export interface MethodologyChange {
  version: string;
  date: string;
  changes: string[];
}

export const METHODOLOGY_CHANGES: MethodologyChange[] = [
  {
    version: "2026-10-r1",
    date: "2026-10-16",
    changes: [
      "Google AI Overview numbers come from our own SERP trackers only. Profound answers (ChatGPT, Perplexity, Gemini, Copilot, AI Mode) were counted as AI Overviews in the post-publish check, the competitor lists and the 7-day snapshot count; they are now shown separately.",
      "Profound's Google AI Mode and Gemini rows are no longer labelled as AI Overviews.",
      "A citation gap is judged on the latest snapshot of the question (at most 45 days old). An older snapshot with an AI Overview no longer keeps a gap open after a newer one shows none.",
      "The refresh scan counts AI Overview citations only; an organic ranking was counted as a citation.",
      "Search Console clicks and GA4 sessions are tied to each published asset through the page they name. Per-asset numbers matched a field no connector writes and read 0.",
      "The site's Search Console click total counts each click once; it summed the page and the query reports.",
      "Crawler hits are rolled up over whole UTC days, and a day's count never goes down.",
      "Excluded questions, paused sites and organisations whose plan has lapsed are no longer tracked.",
      "Competitors are the rivals you name. Forums, review platforms, reference sites, publishers and other cited sites are listed as sources shaping answers, no longer as competitors, and count for less in the queue's scores.",
      "Every answer is labelled with how it was observed and which engine gave it. Profound's ChatGPT, Perplexity, Gemini and Copilot answers are no longer marked as AI Overviews, and their citations sit on the engine's own surface (AI Overview, AI Mode, or another engine's answer). A Gemini answer synced as an AI Overview before Profound's engine names were read correctly stays one until the connector's next 90-day re-sync.",
      "Our own answer probes (each engine's model asked through its API with web search on, via OpenRouter) are reported per engine on Strategy → Visibility, with intervals, and never added to the AI Overview or Profound numbers.",
    ],
  },
];

/**
 * The metrics a restatement covers, with what each page calls them and why
 * they moved. Only figures a page displays that this methodology changed,
 * counted the way the page counts them: the AI Overview cited counts on the
 * Demand and Strategy cards were already read from our own trackers, so
 * restating them against the post-publish check's rule would announce a move
 * no page ever showed. The Refresh page's per-post count did change (organic
 * rankings no longer count), and is restated as the number of posts cited.
 */
export const RESTATED_METRICS = {
  open_gaps: {
    label: "Open citation gaps",
    reason: "Judged on each question's latest snapshot within 45 days; an older AI Overview no longer keeps a closed gap open.",
  },
  topic_gaps: {
    label: "Citation gaps across your topics",
    reason: "A gap now needs a snapshot from the last 45 days, and questions you excluded no longer count.",
  },
  snapshots_7d: {
    label: "Snapshots in the last 7 days",
    reason: "Our own trackers' snapshots only; synced Profound answers were counted too.",
  },
  gsc_clicks_28d: {
    label: "Search Console clicks, 28 days",
    reason: "Each click counted once; the page and query reports were both summed.",
  },
  asset_gsc_clicks_28d: {
    label: "Search Console clicks on published assets, 28 days",
    reason: "Rows are now tied to the asset behind their page; before, none matched.",
  },
  asset_ai_sessions_30d: {
    label: "AI-referred sessions on published assets, 30 days",
    reason: "GA4 landing pages are now tied to the asset behind them; before, none matched.",
  },
  refresh_cited_posts: {
    label: "Posts cited in an AI Overview, 30 days",
    reason: "Only AI Overview citations from our own trackers count; an organic ranking was counted as a citation. Profound's engines are shown separately.",
  },
} as const;

export type RestatedMetric = keyof typeof RESTATED_METRICS;

/** Which restated metrics each page shows. */
export const METHODOLOGY_PAGE_METRICS: Record<"strategy" | "demand" | "attribution" | "refresh", RestatedMetric[]> = {
  // Strategy's gap figure is the per-topic count on each topic card; Demand's is the gap list's badge.
  strategy: ["topic_gaps"],
  demand: ["open_gaps", "snapshots_7d"],
  attribution: ["gsc_clicks_28d", "asset_gsc_clicks_28d", "asset_ai_sessions_30d"],
  refresh: ["refresh_cited_posts"],
};

/** A restatement stays on the page for this long after it was computed, labelled with that date. */
export const RESTATEMENT_NOTICE_DAYS = 60;

export interface RestatementRow {
  metric: RestatedMetric;
  old_value: number;
  new_value: number;
  methodology_version: string;
  reason: string;
  computed_at: string | Date;
}

/** This site's restatements under the current methodology that changed a number, newest first. */
export async function currentRestatements(siteId: string, metrics: readonly RestatedMetric[] | null = null, sql: postgres.Sql = appDb()): Promise<RestatementRow[]> {
  return sql<RestatementRow[]>`
    select metric, old_value::float as old_value, new_value::float as new_value, methodology_version, reason, computed_at
    from app.metric_restatements
    where site_id = ${siteId} and methodology_version = ${METHODOLOGY_VERSION}
      and old_value is distinct from new_value
      and computed_at >= now() - make_interval(days => ${RESTATEMENT_NOTICE_DAYS})
      and (${metrics === null}::boolean or metric = any (${metrics ? [...metrics] : []}::text[]))
    order by computed_at desc, metric`;
}
