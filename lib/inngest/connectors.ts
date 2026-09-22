import { connectorContext, getConnector } from "@/lib/connectors";
import { errorMessage, expireStaleSyncRuns, failRunningSyncRuns, failSyncRun, finishSyncRun, getConnection, lastSuccessfulCursor, listConnections, markWebhookProcessed, progressSyncRun, startSyncRun, withSyncRun } from "@/lib/connectors/store";
import { ConnectorError, type SyncKind, type SyncPage } from "@/lib/connectors/types";
import { ZodError } from "zod";
import { concurrencyCap, connectorSyncCompleted, connectorSyncRequested, connectorWebhookReceived, inngest } from "./client";

/**
 * Connector jobs. One sync function for every provider (the adapter decides
 * what a `kind` means), a daily scheduler that fans out one event per active
 * connection, and a webhook handler that turns a verified event into a
 * `webhook` sync. Every run is a context.context_sync_runs row via
 * withSyncRun, so a failing connector is a red row on the health board, not
 * silence.
 */

const SYNC_RETRIES = 2;
/** Pages one paged run may fetch; 90 days of a large Profound category is ~150 pages of 2,000 rows. */
export const MAX_SYNC_PAGES = 600;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
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
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: concurrencyCap(10) }],
    retries: SYNC_RETRIES,
    // Retries exhausted (a page kept failing, an invocation kept dying): the
    // run row must not stay "running", and the card must say why.
    onFailure: async ({ event, error }) => {
      const { connectionId } = event.data.event.data;
      await failRunningSyncRuns(connectionId, `The sync job failed after ${SYNC_RETRIES + 1} attempts: ${errorMessage(error)}`);
    },
  },
  async ({ event, step, attempt }) => {
    const { connectionId, orgId, kind, payload } = event.data;

    const conn = await step.run("load-connection", () => getConnection(connectionId));
    if (!conn || conn.org_id !== orgId) return { skipped: "connection not found" as const };
    if (!conn.enabled || conn.status === "disconnected" || conn.status === "disabled") return { skipped: `connection ${conn.status}` as const };

    const connector = getConnector(conn.provider);
    const paged = !!connector.syncPage && (connector.pagesSync ? connector.pagesSync(conn as never, kind as SyncKind) : true);

    let outcome: { ok: true; documentsIngested: number; metricsIngested: number; detail: Record<string, unknown> | null } | { ok: false; documentsIngested: number; metricsIngested: number; error: string; detail: null };

    if (!paged) {
      // The whole sync is one step: adapters page through provider APIs with
      // their own cursors, and withSyncRun makes a retry re-read from the last
      // successful cursor rather than from scratch.
      outcome = await step.run("sync", async () => {
        const ctx = connectorContext();
        // A run left "running" by a killed function is closed as failed first,
        // so the health board and the card never show a spinner that never ends.
        await expireStaleSyncRuns(conn.id, ctx.sql);
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
    } else {
      // Page-shaped sync: one run row, one durable step per page. No single
      // invocation outlives the platform limit however large the report, a
      // killed invocation resumes at the page it was on, and the run row
      // carries progress after every page for the connection card.
      const started = await step.run("start-run", async () => {
        const ctx = connectorContext();
        await expireStaleSyncRuns(conn.id, ctx.sql);
        const cursor = await lastSuccessfulCursor(conn.id, ctx.sql);
        const run = await startSyncRun(conn, kind as SyncKind, ctx.sql);
        return { runId: run.id, cursor };
      });
      const run = { id: started.runId, connectionId: conn.id, kind: kind as SyncKind };
      const totals = { documents: 0, metrics: 0, rows: 0, snapshots: 0, pages: 0 };
      let page: SyncPage | null = null;
      let finalCursor: Record<string, unknown> | null = null;
      let detail: Record<string, unknown> = {};
      let done = false;
      let failure: string | null = null;

      for (let i = 0; i < MAX_SYNC_PAGES && !done && !failure; i++) {
        const before = { ...totals };
        const r = await step.run(`page-${i}`, async () => {
          const ctx = connectorContext();
          try {
            const res = await connector.syncPage!({ connection: conn as never, kind: kind as SyncKind, cursor: started.cursor, payload, page }, ctx);
            const d = res.detail ?? {};
            const progress = { ...d, pages: i + 1, rows: before.rows + num(d.rows), snapshots: before.snapshots + num(d.snapshots), metrics: before.metrics + res.metricsIngested };
            await progressSyncRun(run.id, progress, ctx.sql);
            return { ok: true as const, documentsIngested: res.documentsIngested, metricsIngested: res.metricsIngested, next: res.next, cursor: res.cursor, detail: progress };
          } catch (e) {
            if (isTransient(e) && attempt < SYNC_RETRIES) throw e;
            await failSyncRun(run, e, ctx.sql);
            return { ok: false as const, error: errorMessage(e) };
          }
        });
        if (!r.ok) {
          failure = r.error;
          break;
        }
        totals.documents += r.documentsIngested;
        totals.metrics += r.metricsIngested;
        totals.rows = num(r.detail.rows);
        totals.snapshots = num(r.detail.snapshots);
        totals.pages = i + 1;
        detail = r.detail;
        if (!r.next) {
          finalCursor = r.cursor;
          done = true;
        } else {
          page = r.next;
        }
      }

      if (failure) {
        outcome = { ok: false, documentsIngested: 0, metricsIngested: 0, error: failure, detail: null };
      } else if (!done) {
        const message = `Stopped after ${MAX_SYNC_PAGES} pages without reaching the end of the report`;
        await step.run("fail-run", () => failSyncRun(run, new Error(message), connectorContext().sql));
        outcome = { ok: false, documentsIngested: 0, metricsIngested: 0, error: message, detail: null };
      } else {
        const result = { documentsIngested: totals.documents, metricsIngested: totals.metrics, cursor: finalCursor, detail: { ...detail, pages: totals.pages, rows: totals.rows, snapshots: totals.snapshots } };
        await step.run("finish-run", () => finishSyncRun(run, result, connectorContext().sql));
        outcome = { ok: true, documentsIngested: totals.documents, metricsIngested: totals.metrics, detail: result.detail };
      }
    }

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
    concurrency: [{ key: "event.data.connectionId", limit: 1 }, { limit: concurrencyCap(20) }],
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
