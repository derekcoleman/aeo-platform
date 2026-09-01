import type postgres from "postgres";
import { randomBytes } from "node:crypto";
import { appDb } from "@/lib/db/app";
import type { AuditRun } from "./index";
import type { AuditResult } from "./types";

/**
 * Persistence for audit runs. Append-only: a re-audit is a new row.
 *
 * `result` on audit_runs holds the AuditResult (page HTML is not in it);
 * audit_findings and audit_pages are the queryable projection used for
 * diffing and per-page surfaces.
 */
export type AuditKind = "public" | "preflight" | "monitored";
export type AuditStatus = "queued" | "running" | "completed" | "failed";

export interface AuditRunRow {
  id: string;
  org_id: string | null;
  site_id: string | null;
  target_url: string;
  domain: string;
  kind: AuditKind;
  status: AuditStatus;
  geo_score: number | null;
  dimension_scores: AuditResult["dimensions"] | null;
  degraded: AuditResult["degraded"];
  result: AuditResult | null;
  pages_analyzed: number;
  duration_ms: number | null;
  llm_calls: number;
  rule_registry_version: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  created_at: string;
}

export interface PublicAuditRow {
  id: string;
  audit_run_id: string;
  domain: string;
  expires_at: string;
  created_at: string;
}

export function shareSlug(): string {
  return randomBytes(6).toString("base64url");
}

export async function createAuditRun(
  input: { targetUrl: string; domain: string; kind: AuditKind; orgId?: string | null; siteId?: string | null },
  sql: postgres.Sql = appDb(),
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into app.audit_runs (org_id, site_id, target_url, domain, kind, status)
    values (${input.orgId ?? null}, ${input.siteId ?? null}, ${input.targetUrl}, ${input.domain}, ${input.kind}, 'queued')
    returning id`;
  return row!.id;
}

export async function markAuditRunning(id: string, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update app.audit_runs set status = 'running', started_at = now() where id = ${id}`;
}

export async function markAuditFailed(id: string, error: string, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update app.audit_runs set status = 'failed', error = ${error.slice(0, 2000)}, completed_at = now() where id = ${id}`;
}

export async function completeAuditRun(id: string, run: AuditRun, sql: postgres.Sql = appDb()): Promise<void> {
  const { result, pages } = run;
  await sql.begin(async (tx) => {
    await tx`
      update app.audit_runs set
        status = 'completed',
        geo_score = ${result.geoScore},
        dimension_scores = ${tx.json(result.dimensions as unknown as postgres.JSONValue)},
        degraded = ${tx.json(result.degraded as unknown as postgres.JSONValue)},
        result = ${tx.json(result as unknown as postgres.JSONValue)},
        pages_analyzed = ${result.pagesAnalyzed},
        duration_ms = ${result.durationMs},
        llm_calls = ${result.llmCalls},
        rule_registry_version = ${result.ruleRegistryVersion},
        completed_at = now(),
        error = null
      where id = ${id}`;

    await tx`delete from app.audit_findings where audit_run_id = ${id}`;
    await tx`delete from app.audit_pages where audit_run_id = ${id}`;

    if (result.recommendations.length) {
      const findings = result.recommendations.map((r) => ({
        audit_run_id: id,
        rule_key: r.ruleKey,
        category: r.category,
        priority: r.priority,
        passed: false,
        score: null,
        max_score: null,
        evidence: JSON.stringify(r.evidence ?? {}),
        recommendation: JSON.stringify({ title: r.title, description: r.description, impact: r.impact }),
      }));
      await tx`insert into app.audit_findings ${tx(findings)}`;
    }

    if (pages.length) {
      const byUrl = new Map(result.citability?.pages.map((p) => [p.url, p]) ?? []);
      const rows = pages.map((p) => {
        const c = byUrl.get(p.url);
        return {
          audit_run_id: id,
          url: p.url,
          title: p.title.slice(0, 500),
          http_status: p.status,
          scores: JSON.stringify({ structure: p.structure, citability: c && !c.error ? c.averageScore : null }),
          passages: c && !c.error ? JSON.stringify(c.topPassages) : null,
        };
      });
      await tx`insert into app.audit_pages ${tx(rows)} on conflict (audit_run_id, url) do nothing`;
    }
  });
}

export async function getAuditRun(id: string, sql: postgres.Sql = appDb()): Promise<AuditRunRow | null> {
  const [row] = await sql<AuditRunRow[]>`select * from app.audit_runs where id = ${id}`;
  return row ?? null;
}

export async function createPublicAudit(
  input: { auditRunId: string; domain: string; email?: string | null; ip?: string | null; ttlDays?: number },
  sql: postgres.Sql = appDb(),
): Promise<string> {
  const slug = shareSlug();
  await sql`
    insert into app.public_audits (id, audit_run_id, domain, email, expires_at, scanned_by_ip)
    values (${slug}, ${input.auditRunId}, ${input.domain}, ${input.email ?? null},
            now() + make_interval(days => ${input.ttlDays ?? 30}), ${input.ip ?? null})`;
  return slug;
}

/** Share-link read. Expiry is enforced here, not just written. */
export async function getPublicAudit(slug: string, sql: postgres.Sql = appDb()): Promise<{ share: PublicAuditRow; run: AuditRunRow } | null> {
  const [share] = await sql<PublicAuditRow[]>`
    select id, audit_run_id, domain, expires_at, created_at from app.public_audits
    where id = ${slug} and expires_at > now()`;
  if (!share) return null;
  const run = await getAuditRun(share.audit_run_id, sql);
  return run ? { share, run } : null;
}

/** Public scans per IP in the last hour — the abuse guard for the lead magnet. */
export async function recentPublicScansByIp(ip: string, sql: postgres.Sql = appDb()): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from app.public_audits
    where scanned_by_ip = ${ip}::inet and created_at > now() - interval '1 hour'`;
  return Number(row?.n ?? 0);
}

/** Most recent completed public audit for a domain, for cache-hit reuse. */
export async function recentCompletedRunForDomain(domain: string, maxAgeHours: number, sql: postgres.Sql = appDb()): Promise<{ runId: string; slug: string } | null> {
  const [row] = await sql<{ run_id: string; slug: string }[]>`
    select r.id as run_id, p.id as slug from app.audit_runs r
    join app.public_audits p on p.audit_run_id = r.id
    where r.domain = ${domain} and r.kind = 'public' and r.status = 'completed'
      and r.completed_at > now() - make_interval(hours => ${maxAgeHours})
      and p.expires_at > now()
    order by r.completed_at desc limit 1`;
  return row ? { runId: row.run_id, slug: row.slug } : null;
}
