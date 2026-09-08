import { describe, expect, it } from "vitest";
import { QUEUED_STALE_MINUTES, RUNNING_STALE_MINUTES, STALE_QUEUED_MESSAGE, STALE_RUNNING_MESSAGE, staleAuditError } from "@/lib/audit/execute";
import { inngestConfigured } from "@/lib/jobs/runner";

const at = (minutesAgo: number, now: Date) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

describe("staleAuditError", () => {
  const now = new Date("2026-09-08T12:00:00Z");

  it("leaves a fresh queued run alone", () => {
    expect(staleAuditError({ status: "queued", created_at: at(1, now), started_at: null }, now)).toBeNull();
  });

  it("fails a queued run nobody picked up", () => {
    expect(staleAuditError({ status: "queued", created_at: at(QUEUED_STALE_MINUTES + 1, now), started_at: null }, now)).toBe(STALE_QUEUED_MESSAGE);
  });

  it("gives a running run the longer window, measured from started_at", () => {
    const run = { status: "running", created_at: at(60, now), started_at: at(RUNNING_STALE_MINUTES - 1, now) };
    expect(staleAuditError(run, now)).toBeNull();
    expect(staleAuditError({ ...run, started_at: at(RUNNING_STALE_MINUTES + 1, now) }, now)).toBe(STALE_RUNNING_MESSAGE);
  });

  it("never touches finished runs", () => {
    expect(staleAuditError({ status: "completed", created_at: at(999, now), started_at: at(999, now) }, now)).toBeNull();
    expect(staleAuditError({ status: "failed", created_at: at(999, now), started_at: null }, now)).toBeNull();
  });
});

describe("inngestConfigured", () => {
  it("is on in production only with an event key", () => {
    expect(inngestConfigured({ NODE_ENV: "production", VERCEL: "1" })).toBe(false);
    expect(inngestConfigured({ NODE_ENV: "production", INNGEST_EVENT_KEY: "evt_x" })).toBe(true);
  });

  it("assumes the dev server locally", () => {
    expect(inngestConfigured({ NODE_ENV: "development" })).toBe(true);
    expect(inngestConfigured({ NODE_ENV: "test" })).toBe(true);
  });

  it("honours the explicit inline opt-out", () => {
    expect(inngestConfigured({ NODE_ENV: "development", AEO_JOBS_INLINE: "1" })).toBe(false);
    expect(inngestConfigured({ NODE_ENV: "production", INNGEST_EVENT_KEY: "evt_x", AEO_JOBS_INLINE: "true" })).toBe(false);
  });
});
