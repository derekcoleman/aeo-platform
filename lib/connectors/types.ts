import type postgres from "postgres";
import type { SecretStore } from "@/lib/secrets/vault";

/**
 * One adapter shape for every connector. The framework (store.ts, the Inngest
 * sync job, the webhook routes) speaks only this interface; provider modules
 * implement it. Adding a connector means adding a folder, not touching the
 * pipeline.
 *
 * Invariants every adapter honours:
 *  - tokens go through `ctx.secrets`; the connection row holds a `secret_ref`
 *  - sync reads only what `scope` lists — default nothing
 *  - every sync runs inside `withSyncRun`, so failure is a row, never silence
 *  - webhooks are verified, deduped in ops.webhook_events and handed to Inngest
 */

export type ConnectorProvider = "slack" | "google" | "profound" | "webflow" | "website" | "custom";
export type ConnectionStatus = "pending" | "active" | "error" | "disabled" | "disconnected";
export type SyncKind = "backfill" | "incremental" | "webhook" | "upload";

export interface ConnectionRow<Config = Record<string, unknown>> {
  id: string;
  org_id: string;
  site_id: string | null;
  provider: ConnectorProvider;
  status: ConnectionStatus;
  enabled: boolean;
  config: Config;
  scope: string[];
  secret_ref: string | null;
  external_account_id: string | null;
  external_account_name: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  /** When a sync was last requested and accepted by the job runner; null before any manual request. */
  sync_requested_at?: string | null;
  sync_requested_kind?: SyncKind | null;
}

/** The config-independent identity of a connection — what the store needs to write on its behalf. */
export type ConnectionRef = Pick<ConnectionRow<unknown>, "id" | "org_id" | "site_id" | "provider" | "secret_ref">;

export interface ConnectorContext {
  sql: postgres.Sql;
  secrets: SecretStore;
  fetchImpl: typeof fetch;
  now: () => Date;
  /** Per-provider settings that are ours, not the customer's (client ids, signing secrets). */
  env: NodeJS.ProcessEnv;
}

export interface SyncInput<Config = Record<string, unknown>> {
  connection: ConnectionRow<Config>;
  kind: SyncKind;
  /** Cursor from the last successful run of this connection, if any. */
  cursor: Record<string, unknown> | null;
  /** Provider-specific payload for `upload` / `webhook` kinds (CSV text, event body). */
  payload?: unknown;
}

export interface SyncResult {
  documentsIngested: number;
  metricsIngested: number;
  cursor: Record<string, unknown> | null;
  detail?: Record<string, unknown>;
}

/** One page of a paged sync: the connector's own page token, opaque to the job. */
export type SyncPage = Record<string, unknown>;

export interface SyncPageInput<Config = Record<string, unknown>> extends SyncInput<Config> {
  /** The page to fetch; null asks for the first page of this run. */
  page: SyncPage | null;
}

export interface SyncPageResult {
  documentsIngested: number;
  metricsIngested: number;
  /** The next page, or null when this run has nothing more to fetch. */
  next: SyncPage | null;
  /** The cursor to persist for the next run; read on the final page only. */
  cursor: Record<string, unknown> | null;
  /** Progress the job stores on the run row after each page (rows, window, …). */
  detail?: Record<string, unknown>;
}

export interface Connector<Config = Record<string, unknown>> {
  provider: ConnectorProvider;
  /** Validate config + scope at connect time (properties exist, channels reachable). */
  validate?(connection: ConnectionRow<Config>, ctx: ConnectorContext): Promise<void>;
  sync(input: SyncInput<Config>, ctx: ConnectorContext): Promise<SyncResult>;
  /**
   * Page-shaped sync: the job calls this once per page as its own durable
   * step, so a large backfill is never one long invocation. When present,
   * `pagesSync` says which connections and kinds go through it; the rest
   * take `sync`.
   */
  syncPage?(input: SyncPageInput<Config>, ctx: ConnectorContext): Promise<SyncPageResult>;
  pagesSync?(connection: ConnectionRow<Config>, kind: SyncKind): boolean;
  /** Provider-side cleanup (revoke token, leave channels). Row/document cleanup is the store's. */
  disconnect?(connection: ConnectionRow<Config>, ctx: ConnectorContext): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    public readonly provider: ConnectorProvider,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `${provider}: ${code}`);
    this.name = "ConnectorError";
  }
}

export class FeatureDisabledError extends ConnectorError {
  constructor(provider: ConnectorProvider, feature: string) {
    super(provider, "feature_disabled", `${provider}: feature ${feature} is not enabled for this org`);
    this.name = "FeatureDisabledError";
  }
}
