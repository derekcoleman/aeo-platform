import { describe, expect, it } from "vitest";
import type { SyncRunRow } from "@/lib/connectors/store";
import { describeSyncState } from "@/lib/connectors/sync-status";

const now = new Date("2026-09-15T14:00:00Z");
const min = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();
const run = (o: Partial<SyncRunRow>): SyncRunRow => ({ id: "r1", kind: "backfill", status: "succeeded", started_at: min(10), finished_at: min(9), documents_ingested: 0, metrics_ingested: 0, error: null, detail: {}, ...o });

describe("describeSyncState", () => {
  it("is idle before anything was requested or run", () => {
    expect(describeSyncState({ now, requestedAt: null, requestedKind: null, latestRun: null })).toMatchObject({ phase: "idle", live: false });
  });

  it("is queued right after a request and lost once the grace period passes with no run", () => {
    expect(describeSyncState({ now, requestedAt: min(1), requestedKind: "backfill", latestRun: null })).toMatchObject({ phase: "queued", live: true });
    const lost = describeSyncState({ now, requestedAt: min(10), requestedKind: "backfill", latestRun: null });
    expect(lost.phase).toBe("lost");
    expect(lost.live).toBe(false);
    expect(lost.title).toContain("never started");
    expect(lost.fix).toContain("Settings → Deployment");
  });

  it("a request older than the latest run is not pending", () => {
    const s = describeSyncState({ now, requestedAt: min(30), requestedKind: "backfill", latestRun: run({ metrics_ingested: 42, detail: { rows: 120, window: { start: "2026-06-17", end: "2026-07-16" } } }) });
    expect(s.phase).toBe("succeeded");
    expect(s.detail).toBe("120 rows → 42 metrics · window 2026-06-17 → 2026-07-16");
  });

  it("reports a running run as live and a run past the limit as stalled", () => {
    expect(describeSyncState({ now, requestedAt: min(3), requestedKind: "backfill", latestRun: run({ status: "running", started_at: min(2), finished_at: null }) })).toMatchObject({ phase: "running", live: true });
    const stalled = describeSyncState({ now, requestedAt: null, requestedKind: null, latestRun: run({ status: "running", started_at: min(45), finished_at: null }) });
    expect(stalled.phase).toBe("stalled");
    expect(stalled.title).toContain("timed out");
    expect(stalled.fix).toContain("Retry");
  });

  it("surfaces the recorded error on a failed run", () => {
    const s = describeSyncState({ now, requestedAt: null, requestedKind: null, latestRun: run({ status: "failed", error: "profound /v1/prompts/answers: 403 forbidden" }) });
    expect(s).toMatchObject({ phase: "failed", detail: "profound /v1/prompts/answers: 403 forbidden", live: false });
  });

  it("keeps polling while a windowed backfill continues", () => {
    const s = describeSyncState({ now, requestedAt: null, requestedKind: null, latestRun: run({ detail: { window: { start: "2026-06-17", end: "2026-07-16" }, next: { from: "2026-07-17" } } }) });
    expect(s.phase).toBe("running");
    expect(s.live).toBe(true);
    expect(s.detail).toContain("2026-07-17");
  });
});

describe("describeSyncState with paged progress", () => {
  it("counts a run as alive while pages keep reporting progress, and stalled once they stop", () => {
    const old = run({ status: "running", started_at: min(45), finished_at: null, detail: { rows: 24000, pages: 12, progress_at: min(2), window: { start: "2026-06-18", end: "2026-09-16" } } });
    const s = describeSyncState({ now, requestedAt: null, requestedKind: null, latestRun: old });
    expect(s.phase).toBe("running");
    expect(s.live).toBe(true);
    expect(s.detail).toContain("24,000 rows in 12 pages so far");
    const quiet = run({ status: "running", started_at: min(45), finished_at: null, detail: { rows: 24000, pages: 12, progress_at: min(30) } });
    const t = describeSyncState({ now, requestedAt: null, requestedKind: null, latestRun: quiet });
    expect(t.phase).toBe("stalled");
    expect(t.detail).toContain("last progress 30 min ago");
  });
});
