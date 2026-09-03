import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { ProxyMode, SlashMode } from "@/lib/tenancy";
import type { CrawlerAccessReport } from "./crawler-access";
import type { HealthResult, HealthSite } from "./health";
import type { PreflightResult } from "./preflight";

/**
 * Persistence for the monitor and onboarding. Service connection; every
 * statement scopes by site_id / org_id explicitly.
 */

export interface SiteOpsRow {
  id: string;
  org_id: string;
  name: string;
  canonical_domain: string;
  path_prefix: string;
  edge_hostname: string;
  proxy_mode: ProxyMode;
  trailing_slash: SlashMode;
  status: "provisioning" | "verifying" | "active" | "paused" | "disabled";
  health_nonce: string;
  verified_at: string | Date | null;
  health_failures: number;
  last_health_ok: boolean | null;
  health_alerted_at: string | Date | null;
}


export function toHealthSite(row: SiteOpsRow): HealthSite {
  return { id: row.id, canonicalDomain: row.canonical_domain, pathPrefix: row.path_prefix, edgeHostname: row.edge_hostname, proxyMode: row.proxy_mode, trailingSlash: row.trailing_slash };
}

export async function loadSiteOps(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteOpsRow | null> {
  const [row] = await sql<SiteOpsRow[]>`select id, org_id, name, canonical_domain, path_prefix, edge_hostname, proxy_mode, trailing_slash, status, health_nonce, verified_at, health_failures, last_health_ok, health_alerted_at from app.sites where id = ${siteId}`;
  return row ?? null;
}

/** Sites the monitor watches: live ones, and ones mid-verification so a customer fixing their install sees it flip. */
export async function listSitesForHealth(sql: postgres.Sql = appDb()): Promise<{ id: string; org_id: string }[]> {
  return sql<{ id: string; org_id: string }[]>`select id, org_id from app.sites where status in ('active', 'verifying') order by id`;
}

/** The most recently published public path, for the article half of the check. */
export async function latestPublishedPath(siteId: string, sql: postgres.Sql = appDb()): Promise<string | null> {
  const [row] = await sql<{ path: string }[]>`select path from content.published_pages where site_id = ${siteId} order by updated_at desc limit 1`;
  return row?.path ?? null;
}

export const HEALTH_ALERT_AFTER = 2;

export interface HealthTransition {
  failures: number;
  previousOk: boolean | null;
  /** Fire the failure alert: this check crossed the consecutive-failure threshold and none is outstanding. */
  alertFailure: boolean;
  /** Fire the recovery alert: it is healthy again after a failure alert went out. */
  alertRecovery: boolean;
}

/** Record the check and advance the site's state; returns what changed so the caller can alert on transitions only. */
export async function recordHealthCheck(site: Pick<SiteOpsRow, "id" | "org_id">, kind: "monitor" | "verification", result: HealthResult, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<HealthTransition> {
  return sql.begin(async (tx) => {
    const [prev] = await tx<{ health_failures: number; last_health_ok: boolean | null; health_alerted_at: Date | null }[]>`
      select health_failures, last_health_ok, health_alerted_at from app.sites where id = ${site.id} and org_id = ${site.org_id} for update`;
    if (!prev) throw new Error(`site ${site.id} not found`);
    await tx`
      insert into app.site_health_checks (org_id, site_id, kind, checked_at, ok, ttfb_ms, failed, detail)
      values (${site.org_id}, ${site.id}, ${kind}, ${now}, ${result.ok}, ${result.ttfbMs}, ${tx.array(result.failed)}, ${tx.json({ checks: result.checks, warnings: result.warnings } as never)})`;
    const failures = result.ok ? 0 : prev.health_failures + 1;
    const alertFailure = !result.ok && failures >= HEALTH_ALERT_AFTER && prev.health_alerted_at == null;
    const alertRecovery = result.ok && prev.health_alerted_at != null;
    await tx`
      update app.sites
      set health_failures = ${failures}, last_health_at = ${now}, last_health_ok = ${result.ok},
          health_alerted_at = ${alertFailure ? now : alertRecovery ? null : prev.health_alerted_at}
      where id = ${site.id} and org_id = ${site.org_id}`;
    return { failures, previousOk: prev.last_health_ok, alertFailure, alertRecovery };
  });
}

export async function markSiteVerified(siteId: string, orgId: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<void> {
  await sql`update app.sites set status = 'active', verified_at = coalesce(verified_at, ${now}) where id = ${siteId} and org_id = ${orgId} and status in ('provisioning', 'verifying')`;
}

export async function markSiteVerifying(siteId: string, orgId: string, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update app.sites set status = 'verifying' where id = ${siteId} and org_id = ${orgId} and status = 'provisioning'`;
}

// ── preflights ──────────────────────────────────────────────────────────────

export type PreflightKind = "preflight" | "crawler_report";

export interface PreflightRow {
  id: string;
  org_id: string;
  site_id: string;
  kind: PreflightKind;
  status: "queued" | "running" | "completed" | "failed";
  ok: boolean | null;
  result: Record<string, unknown>;
  crawler_access: CrawlerAccessReport | null;
  error: string | null;
}

export async function createPreflight(siteId: string, kind: PreflightKind, sql: postgres.Sql = appDb()): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`insert into app.site_preflights (site_id, kind) values (${siteId}, ${kind}) returning id`;
  if (!row) throw new Error("preflight insert returned no row");
  return row;
}

export async function markPreflightRunning(id: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<void> {
  await sql`update app.site_preflights set status = 'running', started_at = coalesce(started_at, ${now}) where id = ${id}`;
}

export async function completePreflight(id: string, input: { ok: boolean; result: Omit<PreflightResult, "crawlerAccess"> | Record<string, unknown>; crawlerAccess: CrawlerAccessReport | null }, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<void> {
  await sql`
    update app.site_preflights
    set status = 'completed', ok = ${input.ok}, result = ${sql.json(input.result as never)},
        crawler_access = ${input.crawlerAccess ? sql.json(input.crawlerAccess as never) : null}, completed_at = ${now}, error = null
    where id = ${id}`;
}

export async function failPreflight(id: string, error: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<void> {
  await sql`update app.site_preflights set status = 'failed', ok = false, error = ${error.slice(0, 2000)}, completed_at = ${now} where id = ${id}`;
}

export async function loadPreflight(id: string, sql: postgres.Sql = appDb()): Promise<PreflightRow | null> {
  const [row] = await sql<PreflightRow[]>`select id, org_id, site_id, kind, status, ok, result, crawler_access, error from app.site_preflights where id = ${id}`;
  return row ?? null;
}
