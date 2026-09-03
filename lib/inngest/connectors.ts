import { connectorContext, getConnector } from "@/lib/connectors";
import { errorMessage, getConnection, lastSuccessfulCursor, listConnections, markWebhookProcessed, withSyncRun } from "@/lib/connectors/store";
import { ConnectorError, type SyncKind } from "@/lib/connectors/types";
import { ZodError } from "zod";
import { connectorSyncCompleted, connectorSyncRequested, connectorWebhookReceived, inngest } from "./client";

/**
 * Connector jobs. One sync function for every provider (the adapter decides
 * what a `kind` means), a daily scheduler that fans out one event per active
 * connection, and a webhook handler that turns a verified event into a
 * `webhook` sync. Every run is a context.context_sync_runs row via
 * withSyncRun, so a failing connector is a red row on the health board, not
 * silence.
 */

const SYNC_RETRIES = 2;
const PERMANENT_CODES = new Set(["auth", "feature_disabled", "site_required", "site_not_found", "invalid_config", "scope_required"]);

export function isTransient(e: unknown): boolean {
  if (e instanceof ConnectorError) return !PERMANENT_CODES.has(e.code);
  if (e instanceof ZodError) return false;
  return true;
}

export const connectorSyncFunction = inngest.createFunction(
  {
    id: "connector-sync",
    triggers: [connectorSyncRequested],
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: 10 }],
    retries: SYNC_RETRIES,
  },
  async ({ event, step, attempt }) => {
    const { connectionId, orgId, kind, payload } = event.data;

    const conn = await step.run("load-connection", () => getConnection(connectionId));
    if (!conn || conn.org_id !== orgId) return { skipped: "connection not found" as const };
    if (!conn.enabled || conn.status === "disconnected" || conn.status === "disabled") return { skipped: `connection ${conn.status}` as const };

    // The whole sync is one step: adapters page through provider APIs with
    // their own cursors, and withSyncRun makes a retry re-read from the last
    // successful cursor rather than from scratch.
    const outcome = await step.run("sync", async () => {
      const ctx = connectorContext();
      const connector = getConnector(conn.provider);
      const cursor = await lastSuccessfulCursor(conn.id, ctx.sql);
      try {
        const r = await withSyncRun(conn, kind as SyncKind, () => connector.sync({ connection: conn as never, kind: kind as SyncKind, cursor, payload }, ctx), ctx.sql);
        return { ok: true as const, documentsIngested: r.documentsIngested, metricsIngested: r.metricsIngested, detail: r.detail ?? null };
      } catch (e) {
        // withSyncRun already recorded the failure. Auth / feature / config
        // errors will not fix themselves, so report and stop; anything else
        // is re-raised for Inngest to retry until the last attempt.
        if (isTransient(e) && attempt < SYNC_RETRIES) throw e;
        return { ok: false as const, documentsIngested: 0, metricsIngested: 0, error: errorMessage(e), detail: null };
      }
    });

    await step.sendEvent(
      "notify",
      connectorSyncCompleted.create({
        connectionId,
        orgId,
        provider: conn.provider,
        kind,
        ok: outcome.ok,
        documentsIngested: outcome.documentsIngested,
        metricsIngested: outcome.metricsIngested,
        error: outcome.ok ? null : outcome.error,
      }),
    );
    return outcome;
  },
);

/** Daily incremental sync for every active connection; the first run after connect is a backfill. */
export const connectorSyncDaily = inngest.createFunction(
  { id: "connector-sync-daily", triggers: [{ cron: "0 5 * * *" }], retries: 0 },
  async ({ step }) => {
    const conns = await step.run("list", () => listConnections({ activeOnly: true }));
    if (conns.length === 0) return { connections: 0 };
    await step.sendEvent(
      "fan-out",
      conns.map((c) => connectorSyncRequested.create({ connectionId: c.id, orgId: c.org_id, kind: c.last_synced_at ? "incremental" : "backfill" })),
    );
    return { connections: conns.length };
  },
);

/** Verified webhook → `webhook` sync on the resolved connection, then mark the ledger row processed. */
export const connectorWebhookFunction = inngest.createFunction(
  {
    id: "connector-webhook",
    triggers: [connectorWebhookReceived],
    concurrency: [{ key: "event.data.connectionId", limit: 1 }, { limit: 20 }],
    retries: 3,
  },
  async ({ event, step }) => {
    const { provider, externalId, connectionId, orgId, payload } = event.data;
    if (!connectionId || !orgId) {
      await step.run("mark-unrouted", () => markWebhookProcessed(provider, externalId));
      return { skipped: "no connection for event" as const };
    }
    await step.sendEvent("sync", connectorSyncRequested.create({ connectionId, orgId, kind: "webhook", payload }));
    await step.run("mark-processed", () => markWebhookProcessed(provider, externalId));
    return { connectionId, provider, externalId };
  },
);

export const connectorFunctions = [connectorSyncFunction, connectorSyncDaily, connectorWebhookFunction];
