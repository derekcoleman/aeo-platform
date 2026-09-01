import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

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
export async function citationStatus(questionId: string, sql: postgres.Sql = appDb()): Promise<CitationStatus | null> {
  const [snap] = await sql<{ id: string; fetched_at: Date; aio_triggered: boolean | null }[]>`
    select id, fetched_at, aio_triggered from measure.serp_snapshots
    where question_id = ${questionId} order by fetched_at desc limit 1`;
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
