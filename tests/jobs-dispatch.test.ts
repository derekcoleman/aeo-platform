import { describe, expect, it } from "vitest";
import { JOBS_NOT_CONFIGURED, queueJob } from "@/lib/jobs/dispatch";

describe("queueJob", () => {
  it("explains instead of throwing when Inngest is not configured", async () => {
    const prev = { ...process.env };
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "production";
    env.VERCEL = "1";
    delete env.INNGEST_EVENT_KEY;
    try {
      let sent = false;
      const r = await queueJob({ name: "x" }, async () => { sent = true; });
      expect(r).toBe(JOBS_NOT_CONFIGURED);
      expect(sent).toBe(false);
    } finally {
      process.env = prev;
    }
  });

  it("returns null on success and a message on a refused send", async () => {
    const prev = { ...process.env };
    process.env.INNGEST_EVENT_KEY = "evt";
    try {
      expect(await queueJob({ name: "x" }, async () => undefined)).toBeNull();
      const r = await queueJob({ name: "x" }, async () => { throw new Error("401 bad key\nmore"); }, "scan");
      expect(r).toMatch(/Could not queue the scan: 401 bad key$/);
    } finally {
      process.env = prev;
    }
  });
});
