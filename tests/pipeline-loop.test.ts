import { describe, expect, it } from "vitest";
import type { GateStep } from "@/lib/pipeline/gate";
import { citationStatus, loadPublishedAt, POST_PUBLISH_WINDOWS_DAYS, windowDate, windowsStart } from "@/lib/pipeline/loop";
import { fakeSql } from "./helpers/fake-sql";

const fetched = new Date("2026-09-01T09:00:00.000Z");

describe("citationStatus", () => {
  it("is null when the question has never been snapshotted", async () => {
    const sql = fakeSql();
    expect(await citationStatus("q-1", "site-1", sql)).toBeNull();
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]!.text).toContain("order by fetched_at desc limit 1");
    // Another site's snapshot of the same question id must never answer for this one.
    expect(sql.queries[0]!.text).toContain("where question_id = $1 and site_id = $2");
    // Only our own trackers answer: a newer Profound row or answer probe (another engine) must not decide whether the page earned its citation.
    expect(sql.queries[0]!.text).toContain("from measure.v_native_aio where question_id = $1 and site_id = $2");
    expect(sql.queries[0]!.values).toEqual(["q-1", "site-1"]);
  });

  it("reads only AI Overview citations from the latest snapshot and dedupes competitors", async () => {
    const sql = fakeSql([
      [/from measure\.v_native_aio/, () => [{ id: "snap-9", fetched_at: fetched, aio_triggered: true }]],
      [/from measure\.serp_citations/, () => [
        { domain: "okta.com", is_owned: false },
        { domain: "acme.com", is_owned: true },
        { domain: "okta.com", is_owned: false },
        { domain: "microsoft.com", is_owned: false },
      ]],
    ]);
    const status = await citationStatus("q-1", "site-1", sql);
    expect(status).toEqual({ snapshotId: "snap-9", fetchedAt: fetched, aioTriggered: true, owned: true, competitorDomains: ["okta.com", "microsoft.com"] });
    const cites = sql.queries[1]!;
    expect(cites.text).toContain("surface = 'ai_overview'");
    expect(cites.values).toEqual(["snap-9"]);
  });

  it("reports owned:false when an AI Overview cites only competitors", async () => {
    const sql = fakeSql([
      [/from measure\.v_native_aio/, () => [{ id: "snap-1", fetched_at: fetched, aio_triggered: true }]],
      [/from measure\.serp_citations/, () => [{ domain: "okta.com", is_owned: false }]],
    ]);
    const status = await citationStatus("q-1", "site-1", sql);
    expect(status?.owned).toBe(false);
    expect(status?.competitorDomains).toEqual(["okta.com"]);
  });

  it("reports no citations at all when the AI Overview did not trigger", async () => {
    const sql = fakeSql([[/from measure\.v_native_aio/, () => [{ id: "snap-1", fetched_at: fetched, aio_triggered: false }]]]);
    const status = await citationStatus("q-1", "site-1", sql);
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

describe("windowsStart", () => {
  /** `run` executes and round-trips through JSON, as a memoised step result does. */
  function fakeStep() {
    const log: string[] = [];
    const step = {
      async run(id: string, fn: () => unknown) {
        log.push(id);
        return JSON.parse(JSON.stringify(await fn()));
      },
    } as unknown as Pick<GateStep, "run">;
    return { step, log };
  }

  it("starts from the publish step's memoised timestamp, with no extra step", async () => {
    const { step, log } = fakeStep();
    const at = await windowsStart(step, { publishedAt: fetched.toISOString() }, async () => {
      throw new Error("not read");
    });
    expect(at.toISOString()).toBe(fetched.toISOString());
    expect(log).toEqual([]);
  });

  it("replays a publish result from before the timestamp existed: reads the item's publish time in its own step", async () => {
    // What a run published before the fix memoised: no publishedAt.
    const old: { path: string; canonicalUrl: string; etag: string; cms: boolean; publishedAt?: string } = { path: "/resources/sso-vs-scim", canonicalUrl: "https://acme.com/resources/sso-vs-scim", etag: '"e"', cms: false };
    const sql = fakeSql([[/from content\.content_items/, () => [{ published_at: fetched }]]]);
    const { step, log } = fakeStep();
    const at = await windowsStart(step, old, () => loadPublishedAt("item-1", sql));
    expect(at.toISOString()).toBe(fetched.toISOString());
    expect(windowDate(at, 14).toISOString()).toBe("2026-09-15T09:00:00.000Z");
    expect(log).toEqual(["published-at"]);
    expect(sql.queries[0]!.values).toEqual(["item-1"]);
  });

  it("falls back to now when the item has no publish time, never to an Invalid Date", async () => {
    const { step } = fakeStep();
    const at = await windowsStart(step, {}, async () => null);
    expect(Number.isNaN(at.getTime())).toBe(false);
  });
});
