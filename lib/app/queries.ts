import type postgres from "postgres";
import type { ConnectionRow } from "@/lib/connectors/types";
import { appDb } from "@/lib/db/app";
import type { CrawlerAccessReport } from "@/lib/proxy/crawler-access";
import type { OpportunityRow } from "@/lib/pipeline/opportunities";

/**
 * Read models for the dashboard and the ops console. Service connection,
 * explicit scoping on every query; the caller has already been authorised
 * by lib/auth/session.
 */

export async function listOpportunities(siteId: string, limit = 25, sql: postgres.Sql = appDb()): Promise<OpportunityRow[]> {
  return sql<OpportunityRow[]>`
    select id, org_id, site_id, source, status, title, target_query, question_id, content_item_id, score::float as score, evidence
    from content.opportunities where site_id = ${siteId} and status in ('open', 'queued', 'in_progress')
    order by (status = 'in_progress') desc, score desc limit ${limit}`;
}

export interface PreflightSummary {
  id: string;
  kind: "preflight" | "crawler_report";
  status: "queued" | "running" | "completed" | "failed";
  ok: boolean | null;
  blocking: string[];
  crawler_access: CrawlerAccessReport | null;
  error: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
}

export async function listPreflights(siteId: string, limit = 10, sql: postgres.Sql = appDb()): Promise<PreflightSummary[]> {
  const rows = await sql<(Omit<PreflightSummary, "blocking"> & { result: { blocking?: string[] } | null })[]>`
    select id, kind, status, ok, result, crawler_access, error, created_at, completed_at
    from app.site_preflights where site_id = ${siteId} order by created_at desc limit ${limit}`;
  return rows.map((r) => ({ ...r, blocking: Array.isArray(r.result?.blocking) ? r.result!.blocking! : [] }));
}

export interface HealthCheckSummary {
  id: number;
  kind: "monitor" | "verification";
  checked_at: string | Date;
  ok: boolean;
  ttfb_ms: number | null;
  failed: string[];
}

export async function listHealthChecks(siteId: string, limit = 20, sql: postgres.Sql = appDb()): Promise<HealthCheckSummary[]> {
  return sql<HealthCheckSummary[]>`
    select id, kind, checked_at, ok, ttfb_ms, failed from app.site_health_checks
    where site_id = ${siteId} order by checked_at desc limit ${limit}`;
}

export interface PendingApproval {
  id: string;
  kind: "brief" | "draft";
  brief_id: string | null;
  content_version_id: string | null;
  requested_at: string | Date;
  expires_at: string | Date | null;
  title: string | null;
  summary: string | null;
}

export async function listPendingApprovals(siteId: string, sql: postgres.Sql = appDb()): Promise<PendingApproval[]> {
  return sql<PendingApproval[]>`
    select a.id, a.kind, a.brief_id, a.content_version_id, a.requested_at, a.expires_at,
           coalesce(b.spec->>'title', v.title) as title, coalesce(b.target_answer, v.description) as summary
    from content.approvals a
    left join content.briefs b on b.id = a.brief_id
    left join content.content_versions v on v.id = a.content_version_id
    where a.site_id = ${siteId} and a.status = 'pending' order by a.requested_at desc`;
}

export async function listConnectionsForOrg(orgId: string, sql: postgres.Sql = appDb()): Promise<ConnectionRow[]> {
  return sql<ConnectionRow[]>`select * from context.context_connections where org_id = ${orgId} and status <> 'disconnected' order by provider, created_at`;
}

export interface PublishedSummary {
  path: string;
  title: string | null;
  updated_at: string | Date;
}

export async function listPublished(siteId: string, limit = 10, sql: postgres.Sql = appDb()): Promise<PublishedSummary[]> {
  return sql<PublishedSummary[]>`
    select p.path, coalesce(i.title, p.head->>'title') as title, p.updated_at
    from content.published_pages p left join content.content_items i on i.id = p.content_item_id
    where p.site_id = ${siteId} order by p.updated_at desc limit ${limit}`;
}

// ── ops console ─────────────────────────────────────────────────────────────

export interface OpsOrgRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  members: number;
  sites: number;
  profound: boolean;
  created_at: string | Date;
}

export async function opsOrganizations(sql: postgres.Sql = appDb()): Promise<OpsOrgRow[]> {
  return sql<OpsOrgRow[]>`
    select o.id, o.name, o.slug, o.plan, o.status, o.created_at,
           (select count(*) from app.memberships m where m.org_id = o.id)::int as members,
           (select count(*) from app.sites s where s.org_id = o.id)::int as sites,
           app.org_feature_enabled(o.id, 'connector:profound') as profound
    from app.organizations o order by o.created_at desc`;
}

export interface OpsSiteRow {
  id: string;
  org_id: string;
  org_name: string;
  name: string;
  canonical_domain: string;
  path_prefix: string;
  proxy_mode: string;
  status: string;
  last_health_ok: boolean | null;
  last_health_at: string | Date | null;
  health_failures: number;
  published: number;
  open_opportunities: number;
}

export async function opsSites(sql: postgres.Sql = appDb()): Promise<OpsSiteRow[]> {
  return sql<OpsSiteRow[]>`
    select s.id, s.org_id, o.name as org_name, s.name, s.canonical_domain, s.path_prefix, s.proxy_mode::text as proxy_mode, s.status::text as status,
           s.last_health_ok, s.last_health_at, s.health_failures,
           (select count(*) from content.published_pages p where p.site_id = s.id)::int as published,
           (select count(*) from content.opportunities q where q.site_id = s.id and q.status = 'open')::int as open_opportunities
    from app.sites s join app.organizations o on o.id = s.org_id order by s.created_at desc`;
}

export interface FailedSyncRow {
  id: string;
  org_name: string;
  provider: string;
  kind: string;
  started_at: string | Date;
  error: string | null;
}

export async function opsFailedSyncs(days = 7, sql: postgres.Sql = appDb()): Promise<FailedSyncRow[]> {
  return sql<FailedSyncRow[]>`
    select r.id, o.name as org_name, c.provider::text as provider, r.kind::text as kind, r.started_at, r.error
    from context.context_sync_runs r join context.context_connections c on c.id = r.connection_id join app.organizations o on o.id = r.org_id
    where r.status = 'failed' and r.started_at >= now() - make_interval(days => ${days}) order by r.started_at desc limit 50`;
}

export interface SpendRow {
  org_name: string;
  calls: number;
  cost_usd: number;
}

export async function opsLlmSpend(days = 30, sql: postgres.Sql = appDb()): Promise<SpendRow[]> {
  return sql<SpendRow[]>`
    select coalesce(o.name, '(no org)') as org_name, count(*)::int as calls, coalesce(sum(l.cost_usd), 0)::float as cost_usd
    from ops.llm_calls l left join app.organizations o on o.id = l.org_id
    where l.created_at >= now() - make_interval(days => ${days}) group by o.name order by cost_usd desc limit 20`;
}

export interface StaffRow {
  user_id: string;
  email: string;
  name: string | null;
  level: string;
}

export async function opsStaff(sql: postgres.Sql = appDb()): Promise<{ staff: StaffRow[]; bootstrap: { email: string; level: string }[] }> {
  const staff = await sql<StaffRow[]>`select s.user_id, u.email, u.name, s.level from app.internal_staff s join app.users u on u.id = s.user_id order by u.email`;
  const bootstrap = await sql<{ email: string; level: string }[]>`select email, level from app.staff_bootstrap order by email`;
  return { staff, bootstrap };
}
