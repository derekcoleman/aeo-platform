import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Nightly purge. Ingested context (the sensitive material: Slack, calls,
 * docs) goes after the org's retention window — chunks and embeddings
 * cascade with the document. Verified facts, entities, the manifesto and
 * published content are kept: they are the product, not the raw material.
 * Raw crawl events keep 90 days (the daily rollup is the record), SERP
 * cache 30 days, processed webhook payloads 30 days.
 */

export interface PurgeSummary {
  documents: number;
  crawlEvents: number;
  serpCache: number;
  webhookEvents: number;
}

export async function purgeExpired(sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<PurgeSummary> {
  const [docs] = await sql<{ n: number }[]>`
    with gone as (
      delete from context.context_documents d
      using app.organizations o
      where o.id = d.org_id
        and coalesce(d.retention_until, coalesce(d.source_ts, d.created_at) + make_interval(days => o.retention_days)) < ${now}
      returning d.id
    ) select count(*)::int as n from gone`;
  const [crawl] = await sql<{ n: number }[]>`
    with gone as (delete from analytics.crawl_events where ts < ${now}::timestamptz - interval '90 days' returning id)
    select count(*)::int as n from gone`;
  const [cache] = await sql<{ n: number }[]>`
    with gone as (delete from measure.serp_cache where day < (${now}::timestamptz)::date - 30 returning key)
    select count(*)::int as n from gone`;
  const [hooks] = await sql<{ n: number }[]>`
    with gone as (delete from ops.webhook_events where processed_at is not null and received_at < ${now}::timestamptz - interval '30 days' returning id)
    select count(*)::int as n from gone`;
  return { documents: docs?.n ?? 0, crawlEvents: crawl?.n ?? 0, serpCache: cache?.n ?? 0, webhookEvents: hooks?.n ?? 0 };
}
