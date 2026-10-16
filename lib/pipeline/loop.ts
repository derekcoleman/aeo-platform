import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { GateStep } from "./gate";

/**
 * The post-publish loop. An article that did not earn its citation is not a
 * failure to shrug at; at each window we re-check the SERP and, if we are
 * still absent, open a refresh opportunity for the asset we already made.
 */

export const POST_PUBLISH_WINDOWS_DAYS = [14, 30, 60] as const;

export interface CitationStatus {
  snapshotId: string;
  fetchedAt: Date;
  aioTriggered: boolean | null;
  /** We hold at least one AI Overview citation in the latest snapshot. */
  owned: boolean;
  competitorDomains: string[];
}

/** The latest snapshot for a question, with whether any AI Overview citation is ours. */
export async function citationStatus(questionId: string, siteId: string, sql: postgres.Sql = appDb()): Promise<CitationStatus | null> {
  const [snap] = await sql<{ id: string; fetched_at: Date; aio_triggered: boolean | null }[]>`
    select id, fetched_at, aio_triggered from measure.serp_snapshots
    where question_id = ${questionId} and site_id = ${siteId} order by fetched_at desc limit 1`;
  if (!snap) return null;
  const cites = await sql<{ domain: string; is_owned: boolean }[]>`
    select domain, is_owned from measure.serp_citations
    where serp_snapshot_id = ${snap.id} and surface = 'ai_overview' order by position`;
  return {
    snapshotId: snap.id,
    fetchedAt: snap.fetched_at,
    aioTriggered: snap.aio_triggered,
    owned: cites.some((c) => c.is_owned),
    competitorDomains: [...new Set(cites.filter((c) => !c.is_owned).map((c) => c.domain))],
  };
}

export function windowDate(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

/** The item's stored publish time (both the proxy and the CMS publish paths set it). */
export async function loadPublishedAt(contentItemId: string, sql: postgres.Sql = appDb()): Promise<Date | null> {
  const [row] = await sql<{ published_at: Date | null }[]>`select published_at from content.content_items where id = ${contentItemId}`;
  return row?.published_at ?? null;
}

/**
 * Where the re-measure windows start: the publish step's memoised timestamp,
 * so a replay cannot move them. A run that published before the step
 * returned one replays a result without it, and `new Date(undefined)` would
 * make every `sleepUntil` throw, even for a sleep that already ran. That run
 * reads the item's publish time in a step of its own instead.
 */
export async function windowsStart(step: Pick<GateStep, "run">, published: { publishedAt?: string | null }, load: () => Promise<Date | null>): Promise<Date> {
  if (published.publishedAt) return new Date(published.publishedAt);
  const at = await step.run("published-at", async () => ((await load()) ?? new Date()).toISOString());
  return new Date(at);
}
