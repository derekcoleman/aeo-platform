import { describe, expect, it } from "vitest";
import { citationStatus, POST_PUBLISH_WINDOWS_DAYS, windowDate } from "@/lib/pipeline/loop";
import { fakeSql } from "./helpers/fake-sql";

const fetched = new Date("2026-09-01T09:00:00.000Z");

describe("citationStatus", () => {
  it("is null when the question has never been snapshotted", async () => {
    const sql = fakeSql();
    expect(await citationStatus("q-1", sql)).toBeNull();
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]!.text).toContain("order by fetched_at desc limit 1");
  });

  it("reads only AI Overview citations from the latest snapshot and dedupes competitors", async () => {
    const sql = fakeSql([
      [/from measure\.serp_snapshots/, () => [{ id: "snap-9", fetched_at: fetched, aio_triggered: true }]],
      [/from measure\.serp_citations/, () => [
        { domain: "okta.com", is_owned: false },
        { domain: "acme.com", is_owned: true },
        { domain: "okta.com", is_owned: false },
        { domain: "microsoft.com", is_owned: false },
      ]],
    ]);
    const status = await citationStatus("q-1", sql);
    expect(status).toEqual({ snapshotId: "snap-9", fetchedAt: fetched, aioTriggered: true, owned: true, competitorDomains: ["okta.com", "microsoft.com"] });
    const cites = sql.queries[1]!;
    expect(cites.text).toContain("surface = 'ai_overview'");
    expect(cites.values).toEqual(["snap-9"]);
  });

  it("reports owned:false when an AI Overview cites only competitors", async () => {
    const sql = fakeSql([
      [/from measure\.serp_snapshots/, () => [{ id: "snap-1", fetched_at: fetched, aio_triggered: true }]],
      [/from measure\.serp_citations/, () => [{ domain: "okta.com", is_owned: false }]],
    ]);
    const status = await citationStatus("q-1", sql);
    expect(status?.owned).toBe(false);
    expect(status?.competitorDomains).toEqual(["okta.com"]);
  });

  it("reports no citations at all when the AI Overview did not trigger", async () => {
    const sql = fakeSql([[/from measure\.serp_snapshots/, () => [{ id: "snap-1", fetched_at: fetched, aio_triggered: false }]]]);
    const status = await citationStatus("q-1", sql);
    expect(status).toMatchObject({ aioTriggered: false, owned: false, competitorDomains: [] });
  });
});

describe("post-publish windows", () => {
  it("re-checks at +14, +30 and +60 days", () => {
    expect([...POST_PUBLISH_WINDOWS_DAYS]).toEqual([14, 30, 60]);
    expect(windowDate(fetched, 14).toISOString()).toBe("2026-09-15T09:00:00.000Z");
    expect(windowDate(fetched, 60).toISOString()).toBe("2026-10-31T09:00:00.000Z");
  });
});
