import { createHash } from "node:crypto";
import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { connectionSecretRef, looksLikeSecret, type SecretStore } from "@/lib/secrets/vault";
import type { ConnectionRef, ConnectionRow, ConnectorProvider, SyncKind, SyncResult } from "./types";

/**
 * Persistence shared by every connector. Runs on the service connection and
 * scopes by org_id / connection_id explicitly on every statement.
 */

export interface CreateConnectionInput {
  orgId: string;
  siteId?: string | null;
  provider: ConnectorProvider;
  config?: Record<string, unknown>;
  scope?: string[];
  /** The raw token / refresh token / API key. Goes to Vault, never to the row. */
  secret?: string | null;
  externalAccountId?: string | null;
  externalAccountName?: string | null;
  createdBy?: string | null;
  status?: ConnectionRow["status"];
}

export async function createConnection(
  input: CreateConnectionInput,
  secrets: SecretStore,
  sql: postgres.Sql = appDb(),
): Promise<ConnectionRow> {
  const config = input.config ?? {};
  const scope = input.scope ?? [];
  assertNoSecretsInConfig(config);
  const [row] = await sql<ConnectionRow[]>`
    insert into context.context_connections
      (org_id, site_id, provider, status, config, scope, external_account_id, external_account_name, created_by)
    values (${input.orgId}, ${input.siteId ?? null}, ${input.provider}, ${input.status ?? "pending"},
            ${sql.json(config as never)}, ${sql.json(scope as never)},
            ${input.externalAccountId ?? null}, ${input.externalAccountName ?? null}, ${input.createdBy ?? null})
    returning *`;
  if (!row) throw new Error("connection insert returned no row");
  if (input.secret) {
    const ref = await secrets.put(connectionSecretRef(row.id), input.secret, `${input.provider} connection ${row.id}`);
    const [updated] = await sql<ConnectionRow[]>`
      update context.context_connections set secret_ref = ${ref}, status = ${input.status ?? "active"}, updated_at = now()
      where id = ${row.id} and org_id = ${input.orgId} returning *`;
    return updated ?? { ...row, secret_ref: ref };
  }
  return row;
}

const SECRET_KEY_RE = /token|secret|password|api_?key|refresh|credential/i;

/**
 * Config is customer-readable (RLS tenant_read), so a token in it would leak
 * to every org member. Reject keys that name a secret, and values that look
 * like one under any key.
 */
export function assertNoSecretsInConfig(config: Record<string, unknown>, path = "config"): void {
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEY_RE.test(k)) throw new Error(`${path}.${k}: secrets belong in Vault, not in config`);
    if (typeof v === "string" && looksLikeSecret(v) && /^(xox[abp]-|ya29\.|1\/\/|sk-|ghp_)/.test(v)) {
      throw new Error(`${path}.${k}: value looks like a credential`);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) assertNoSecretsInConfig(v as Record<string, unknown>, `${path}.${k}`);
  }
}

export async function rotateConnectionSecret(conn: ConnectionRef, secret: string, secrets: SecretStore, sql: postgres.Sql = appDb()): Promise<string> {
  const ref = await secrets.put(connectionSecretRef(conn.id), secret);
  await sql`update context.context_connections set secret_ref = ${ref}, updated_at = now() where id = ${conn.id} and org_id = ${conn.org_id}`;
  return ref;
}

export async function getConnection(id: string, sql: postgres.Sql = appDb()): Promise<ConnectionRow | null> {
  const [row] = await sql<ConnectionRow[]>`select * from context.context_connections where id = ${id}`;
  return row ?? null;
}

export async function listConnections(
  filter: { orgId?: string; provider?: ConnectorProvider; activeOnly?: boolean } = {},
  sql: postgres.Sql = appDb(),
): Promise<ConnectionRow[]> {
  return sql<ConnectionRow[]>`
    select * from context.context_connections
    where true
      ${filter.orgId ? sql`and org_id = ${filter.orgId}` : sql``}
      ${filter.provider ? sql`and provider = ${filter.provider}` : sql``}
      ${filter.activeOnly ? sql`and enabled and status in ('active', 'error')` : sql``}
    order by created_at`;
}

export async function updateConnection(
  conn: Pick<ConnectionRow, "id" | "org_id">,
  patch: Partial<Pick<ConnectionRow, "config" | "scope" | "status" | "enabled" | "external_account_id" | "external_account_name" | "last_error">>,
  sql: postgres.Sql = appDb(),
): Promise<void> {
  await sql`
    update context.context_connections set
      config = coalesce(${patch.config ? sql.json(patch.config as never) : null}, config),
      scope = coalesce(${patch.scope ? sql.json(patch.scope as never) : null}, scope),
      status = coalesce(${patch.status ?? null}, status),
      enabled = coalesce(${patch.enabled ?? null}, enabled),
      external_account_id = coalesce(${patch.external_account_id ?? null}, external_account_id),
      external_account_name = coalesce(${patch.external_account_name ?? null}, external_account_name),
      last_error = ${patch.last_error === undefined ? sql`last_error` : patch.last_error},
      updated_at = now()
    where id = ${conn.id} and org_id = ${conn.org_id}`;
}

/**
 * Disconnect cascades: the Vault secret is deleted first (if that fails we
 * must not leave a live token behind a "disconnected" row), then documents,
 * sync runs and external metrics follow the FK cascade / set-null.
 */
export async function disconnectConnection(conn: ConnectionRef, secrets: SecretStore, sql: postgres.Sql = appDb()): Promise<void> {
  if (conn.secret_ref) await secrets.delete(conn.secret_ref);
  await sql`delete from context.context_documents where connection_id = ${conn.id} and org_id = ${conn.org_id}`;
  await sql`
    update context.context_connections
    set status = 'disconnected', enabled = false, secret_ref = null, updated_at = now()
    where id = ${conn.id} and org_id = ${conn.org_id}`;
}

// ── feature flags ───────────────────────────────────────────────────────────

export async function isFeatureEnabled(orgId: string, feature: string, sql: postgres.Sql = appDb()): Promise<boolean> {
  const [row] = await sql<{ enabled: boolean }[]>`select app.org_feature_enabled(${orgId}, ${feature}) as enabled`;
  return row?.enabled === true;
}

export async function setFeature(orgId: string, feature: string, enabled: boolean, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`
    insert into app.org_features (org_id, feature, enabled) values (${orgId}, ${feature}, ${enabled})
    on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_at = now()`;
}

// ── sync runs ───────────────────────────────────────────────────────────────

export interface SyncRunHandle {
  id: string;
  connectionId: string;
  kind: SyncKind;
}

export async function lastSuccessfulCursor(connectionId: string, sql: postgres.Sql = appDb()): Promise<Record<string, unknown> | null> {
  const [row] = await sql<{ cursor: Record<string, unknown> | null }[]>`
    select cursor from context.context_sync_runs
    where connection_id = ${connectionId} and status = 'succeeded' and cursor is not null
    order by started_at desc limit 1`;
  return row?.cursor ?? null;
}

export async function startSyncRun(conn: Pick<ConnectionRow, "id" | "org_id">, kind: SyncKind, sql: postgres.Sql = appDb()): Promise<SyncRunHandle> {
  const [row] = await sql<{ id: string }[]>`
    insert into context.context_sync_runs (org_id, connection_id, kind) values (${conn.org_id}, ${conn.id}, ${kind}) returning id`;
  return { id: row!.id, connectionId: conn.id, kind };
}

export async function finishSyncRun(run: SyncRunHandle, result: SyncResult, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`
    update context.context_sync_runs set
      status = 'succeeded', finished_at = now(),
      documents_ingested = ${result.documentsIngested}, metrics_ingested = ${result.metricsIngested},
      cursor = ${result.cursor ? sql.json(result.cursor as never) : null},
      detail = ${sql.json((result.detail ?? {}) as never)}
    where id = ${run.id}`;
  await sql`
    update context.context_connections set last_synced_at = now(), last_error = null, status = 'active', updated_at = now()
    where id = ${run.connectionId} and status <> 'disconnected'`;
}

export async function failSyncRun(run: SyncRunHandle, error: unknown, sql: postgres.Sql = appDb()): Promise<void> {
  const message = errorMessage(error);
  await sql`
    update context.context_sync_runs set status = 'failed', finished_at = now(), error = ${message}
    where id = ${run.id}`;
  await sql`
    update context.context_connections set last_error = ${message}, status = 'error', updated_at = now()
    where id = ${run.connectionId} and status in ('active', 'pending', 'error')`;
}

/**
 * The only way a connector sync runs. A throw anywhere inside `fn` becomes a
 * failed run with the error recorded and the connection flagged; the throw is
 * then re-raised so Inngest retries and the ops board sees it.
 */
export async function withSyncRun<T extends SyncResult>(
  conn: Pick<ConnectionRow, "id" | "org_id">,
  kind: SyncKind,
  fn: (run: SyncRunHandle) => Promise<T>,
  sql: postgres.Sql = appDb(),
): Promise<T> {
  const run = await startSyncRun(conn, kind, sql);
  try {
    const result = await fn(run);
    await finishSyncRun(run, result, sql);
    return result;
  } catch (err) {
    await failSyncRun(run, err, sql);
    throw err;
  }
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Never let a token that leaked into an error string reach the row.
  return raw.replace(/(xox[abp]-[A-Za-z0-9-]+|ya29\.[A-Za-z0-9_-]+|Bearer\s+\S+)/g, "[redacted]").slice(0, 1000);
}

// ── documents ───────────────────────────────────────────────────────────────

export interface DocumentInput {
  kind: string;
  externalId: string;
  title?: string | null;
  text: string;
  metadata?: Record<string, unknown>;
  sourceTs?: Date | string | null;
  siteId?: string | null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Insert-or-update by (connection, external_id); unchanged content is a no-op. Returns rows written. */
export async function upsertDocuments(
  conn: ConnectionRef,
  docs: DocumentInput[],
  opts: { retentionDays?: number | null } = {},
  sql: postgres.Sql = appDb(),
): Promise<number> {
  let written = 0;
  for (const d of docs) {
    if (!d.text.trim()) continue;
    const hash = sha256(d.text);
    const rows = await sql`
      insert into context.context_documents
        (org_id, connection_id, site_id, provider, kind, external_id, title, text, content_sha256, metadata, source_ts, retention_until)
      values (${conn.org_id}, ${conn.id}, ${d.siteId ?? conn.site_id}, ${conn.provider}, ${d.kind}, ${d.externalId},
              ${d.title ?? null}, ${d.text}, ${hash}, ${sql.json((d.metadata ?? {}) as never)},
              ${d.sourceTs ? new Date(d.sourceTs) : null},
              ${opts.retentionDays ? new Date(Date.now() + opts.retentionDays * 86_400_000) : null})
      on conflict (connection_id, external_id) do update
        set title = excluded.title, text = excluded.text, content_sha256 = excluded.content_sha256,
            metadata = excluded.metadata, source_ts = excluded.source_ts, redacted = false, updated_at = now()
        where context.context_documents.content_sha256 <> excluded.content_sha256
      returning id`;
    written += rows.length;
  }
  return written;
}

// ── external metrics (GSC / GA4 / Profound) ─────────────────────────────────

export interface ExternalMetricInput {
  provider: "gsc" | "ga4" | "profound";
  surface: string;
  dimension: Record<string, unknown>;
  date: string; // YYYY-MM-DD
  metrics: Record<string, number | string | null>;
  contentId?: string | null;
  questionId?: string | null;
}

export async function upsertExternalMetrics(
  conn: ConnectionRef & { site_id: string },
  rows: ExternalMetricInput[],
  sql: postgres.Sql = appDb(),
): Promise<number> {
  let written = 0;
  for (const m of rows) {
    const res = await sql`
      insert into measure.external_metrics
        (org_id, site_id, connection_id, provider, surface, dimension, date, metrics, content_id, question_id, fetched_at)
      values (${conn.org_id}, ${conn.site_id}, ${conn.id}, ${m.provider}, ${m.surface}, ${sql.json(m.dimension as never)},
              ${m.date}, ${sql.json(m.metrics as never)}, ${m.contentId ?? null}, ${m.questionId ?? null}, now())
      on conflict (site_id, provider, surface, dimension, date) do update
        set metrics = excluded.metrics, connection_id = excluded.connection_id,
            content_id = coalesce(excluded.content_id, measure.external_metrics.content_id),
            question_id = coalesce(excluded.question_id, measure.external_metrics.question_id),
            fetched_at = now()
      returning id`;
    written += res.length;
  }
  return written;
}

// ── webhook ledger ──────────────────────────────────────────────────────────

/** Returns false when this (provider, external_id) was already recorded — the caller must not re-emit. */
export async function recordWebhookEvent(provider: string, externalId: string, payload: unknown, sql: postgres.Sql = appDb()): Promise<boolean> {
  const rows = await sql`
    insert into ops.webhook_events (provider, external_id, payload)
    values (${provider}, ${externalId}, ${sql.json(payload as never)})
    on conflict (provider, external_id) do nothing
    returning id`;
  return rows.length > 0;
}

export async function markWebhookProcessed(provider: string, externalId: string, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update ops.webhook_events set processed_at = now() where provider = ${provider} and external_id = ${externalId}`;
}
