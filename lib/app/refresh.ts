import type postgres from "postgres";
import type { ConnectionRow } from "@/lib/connectors/types";
import { appDb } from "@/lib/db/app";
import { REFRESH_THRESHOLD, type RefreshScore, type RefreshSignals } from "@/lib/refresh/score";

/**
 * Read models for the Refresh page: the inventory with its scores and
 * signals, the refresh opportunity (if any) behind each row, and where the
 * data came from so every number can be labelled.
 */

export interface RefreshItemRow {
  id: string;
  collection_name: string;
  collection_slug: string;
  external_id: string;
  slug: string | null;
  title: string | null;
  url: string | null;
  word_count: number;
  is_draft: boolean;
  is_archived: boolean;
  missing: boolean;
  has_body: boolean;
  created_on: string | Date | null;
  last_updated: string | Date | null;
  last_published: string | Date | null;
  content_item_id: string | null;
  content_status: string | null;
  refresh_score: number | null;
  refresh_breakdown: RefreshScore["breakdown"] | null;
  refresh_signals: (RefreshSignals & { exclusion?: string | null }) | null;
  refresh_reasons: string[];
  scored_at: string | Date | null;
  last_refreshed_at: string | Date | null;
  opportunity_id: string | null;
  opportunity_status: string | null;
  pending_approval_id: string | null;
}

export async function listRefreshItems(siteId: string, limit = 500, sql: postgres.Sql = appDb()): Promise<RefreshItemRow[]> {
  return sql<RefreshItemRow[]>`
    select i.id, i.collection_name, i.collection_slug, i.external_id, i.slug, i.title, i.url, i.word_count, i.is_draft, i.is_archived,
           (i.missing_since is not null) as missing, (i.body_html is not null) as has_body,
           i.created_on, i.last_updated, i.last_published, i.content_item_id, ci.status as content_status,
           i.refresh_score::float as refresh_score, i.refresh_breakdown, i.refresh_signals, i.refresh_reasons, i.scored_at, i.last_refreshed_at,
           o.id as opportunity_id, o.status as opportunity_status,
           (select a.id from content.approvals a where a.site_id = i.site_id and a.status = 'pending'
              and (a.brief_id in (select b.id from content.briefs b where b.opportunity_id = o.id)
                   or a.content_version_id in (select v.id from content.content_versions v where v.content_item_id = i.content_item_id))
            order by a.requested_at desc limit 1) as pending_approval_id
    from content.cms_items i
    left join content.content_items ci on ci.id = i.content_item_id
    left join lateral (
      select id, status from content.opportunities o
      where o.site_id = i.site_id and o.source = 'refresh' and o.evidence->>'cmsItemId' = i.id::text
      order by (o.status in ('queued', 'in_progress')) desc, (o.status = 'open') desc, o.updated_at desc limit 1
    ) o on true
    where i.site_id = ${siteId}
    order by i.refresh_score desc nulls last, i.last_updated asc nulls first
    limit ${limit}`;
}

export interface RefreshOverview {
  connection: ConnectionRow | null;
  items: number;
  collections: number;
  candidates: number;
  scoredAt: string | Date | null;
  lastSyncedAt: string | Date | null;
  lastRefreshedAt: string | Date | null;
}

export async function refreshOverview(siteId: string, orgId: string, sql: postgres.Sql = appDb()): Promise<RefreshOverview> {
  const [conn] = await sql<ConnectionRow[]>`
    select * from context.context_connections
    where org_id = ${orgId} and provider = 'webflow' and status <> 'disconnected' and (site_id = ${siteId} or site_id is null)
    order by (site_id = ${siteId}) desc, created_at desc limit 1`;
  const [agg] = await sql<{ items: number; collections: number; candidates: number; scored_at: string | Date | null; last_refreshed_at: string | Date | null }[]>`
    select count(*)::int as items, count(distinct collection_id)::int as collections,
           count(*) filter (where refresh_score >= ${REFRESH_THRESHOLD} and missing_since is null and not is_draft and not is_archived and body_html is not null and (refresh_signals->>'exclusion') is null)::int as candidates,
           max(scored_at) as scored_at, max(last_refreshed_at) as last_refreshed_at
    from content.cms_items where site_id = ${siteId}`;
  return {
    connection: conn ?? null,
    items: agg?.items ?? 0,
    collections: agg?.collections ?? 0,
    candidates: agg?.candidates ?? 0,
    scoredAt: agg?.scored_at ?? null,
    lastSyncedAt: conn?.last_synced_at ?? null,
    lastRefreshedAt: agg?.last_refreshed_at ?? null,
  };
}
