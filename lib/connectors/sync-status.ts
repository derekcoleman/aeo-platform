import type { SyncRunRow } from "./store";

/**
 * What a connection's sync is doing right now, derived from the latest run
 * row and the last accepted request. Pure, so the connection card and the
 * health board describe the same state the same way.
 *
 *   queued     the event was accepted moments ago; the runner has not started it yet
 *   lost       the event was accepted, the grace period passed, nothing ran
 *   running    a run is in progress (or a backfill window just finished and the next is queued)
 *   stalled    a run has been "running" past the limit; it was killed and never reported
 *   failed     the latest run recorded an error
 *   succeeded  the latest run finished cleanly
 *   idle       never requested, never run
 */
export type SyncPhase = "idle" | "queued" | "lost" | "running" | "stalled" | "failed" | "succeeded";

export interface SyncState {
  phase: SyncPhase;
  /** One line for the card. */
  title: string;
  /** The reason or the numbers behind the title. */
  detail: string | null;
  /** What to do about it, when there is something to do. */
  fix: string | null;
  /** True while the page should keep polling. */
  live: boolean;
  /** The run this state describes, if any. */
  run: SyncRunRow | null;
}

export interface SyncStateInput {
  now: Date;
  requestedAt: string | Date | null | undefined;
  requestedKind: string | null | undefined;
  latestRun: SyncRunRow | null;
  /** Grace period after a request before the absence of a run is an error. */
  queueGraceMs?: number;
  /** A run older than this and still "running" was killed. */
  staleRunMs?: number;
}

export const QUEUE_GRACE_MS = 3 * 60 * 1000;
export const STALE_RUN_MS = 20 * 60 * 1000;

const LOST_FIX = "The job runner (Inngest) is not receiving events from this deployment, or has not synced this app. Settings → Deployment runs the live checks and names the fix.";
const STALLED_FIX = "Retry. Each page of the report is now its own step, so a retry resumes where it stopped instead of starting over.";

const kindLabel = (k: string | null | undefined) => (k === "backfill" ? "backfill" : k === "incremental" ? "incremental sync" : k ? `${k} sync` : "sync");

function ago(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function progressOf(detail: Record<string, unknown>): string {
  const rows = typeof detail.rows === "number" ? detail.rows : null;
  const pages = typeof detail.pages === "number" ? detail.pages : null;
  if (rows === null) return "";
  return ` · ${rows.toLocaleString("en-US")} rows${pages ? ` in ${pages} page${pages === 1 ? "" : "s"}` : ""} so far`;
}

function windowOf(detail: Record<string, unknown>): string | null {
  const w = detail.window as { start?: unknown; end?: unknown } | undefined;
  return w && typeof w.start === "string" && typeof w.end === "string" ? `${w.start} → ${w.end}` : null;
}

export function describeSyncState(input: SyncStateInput): SyncState {
  const { now, latestRun } = input;
  const grace = input.queueGraceMs ?? QUEUE_GRACE_MS;
  const stale = input.staleRunMs ?? STALE_RUN_MS;
  const requestedAt = input.requestedAt ? new Date(input.requestedAt) : null;
  const runStarted = latestRun ? new Date(latestRun.started_at) : null;
  const pendingRequest = requestedAt && (!runStarted || requestedAt.getTime() > runStarted.getTime());

  if (latestRun && latestRun.status === "running" && runStarted) {
    const progressAt = typeof latestRun.detail.progress_at === "string" ? new Date(latestRun.detail.progress_at) : null;
    const lastSign = progressAt && !Number.isNaN(progressAt.getTime()) ? progressAt : runStarted;
    const age = now.getTime() - lastSign.getTime();
    if (age > stale) {
      return { phase: "stalled", title: `The ${kindLabel(latestRun.kind)} timed out`, detail: `Started ${ago(runStarted, now)}, last progress ${ago(lastSign, now)}; the function was killed by its time limit.${windowOf(latestRun.detail) ? ` Window ${windowOf(latestRun.detail)}.` : ""}`, fix: STALLED_FIX, live: false, run: latestRun };
    }
    return { phase: "running", title: `${capitalize(kindLabel(latestRun.kind))} running`, detail: `Started ${ago(runStarted, now)}${progressOf(latestRun.detail)}${windowOf(latestRun.detail) ? ` · window ${windowOf(latestRun.detail)}` : ""}`, fix: null, live: true, run: latestRun };
  }

  if (pendingRequest && requestedAt) {
    const age = now.getTime() - requestedAt.getTime();
    if (age <= grace) {
      return { phase: "queued", title: `${capitalize(kindLabel(input.requestedKind))} queued ${ago(requestedAt, now)}`, detail: "Waiting for the job runner to start it; this usually takes seconds.", fix: null, live: true, run: latestRun };
    }
    return { phase: "lost", title: `The ${kindLabel(input.requestedKind)} never started`, detail: `Queued ${ago(requestedAt, now)}; no run has begun since.`, fix: LOST_FIX, live: false, run: latestRun };
  }

  if (latestRun && latestRun.status === "failed") {
    return { phase: "failed", title: `The ${kindLabel(latestRun.kind)} failed`, detail: latestRun.error ?? "No error message was recorded.", fix: /timed out/i.test(latestRun.error ?? "") ? STALLED_FIX : null, live: false, run: latestRun };
  }

  if (latestRun && latestRun.status === "succeeded") {
    const next = latestRun.detail.next as { from?: unknown } | null | undefined;
    if (next && typeof next.from === "string") {
      return { phase: "running", title: "Backfill continuing", detail: `Window ${windowOf(latestRun.detail) ?? "done"} landed; the next window from ${next.from} is queued.`, fix: null, live: true, run: latestRun };
    }
    const finished = latestRun.finished_at ? new Date(latestRun.finished_at) : runStarted;
    const rows = typeof latestRun.detail.rows === "number" ? `${latestRun.detail.rows} rows → ` : "";
    return { phase: "succeeded", title: `Last ${kindLabel(latestRun.kind)} succeeded ${finished ? ago(finished, now) : ""}`.trim(), detail: `${rows}${latestRun.metrics_ingested} metrics${latestRun.documents_ingested ? `, ${latestRun.documents_ingested} documents` : ""}${windowOf(latestRun.detail) ? ` · window ${windowOf(latestRun.detail)}` : ""}`, fix: null, live: false, run: latestRun };
  }

  return { phase: "idle", title: "Never synced", detail: null, fix: null, live: false, run: null };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
