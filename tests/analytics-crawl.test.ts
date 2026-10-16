import { describe, expect, it } from "vitest";
import { crawlIngestSchema, insertCrawlEvents, prepareCrawlRows, rollupCrawlDaily } from "@/lib/analytics/crawl";
import { noteWorkerVersion, resetWorkerVersionMemo } from "@/lib/analytics/ingest";
import { fakeSql } from "./helpers/fake-sql";

const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const now = new Date("2026-09-04T12:00:00Z");
const ranges = { "chatgpt-user": ["20.15.240.64/28"] };

describe("prepareCrawlRows", () => {
  it("classifies by UA, verifies by IP, hashes the address and strips the query", () => {
    const rows = prepareCrawlRows(
      [
        { path: "/resources/sso-vs-scim?utm=1#x", ua: "ChatGPT-User/1.0", ip: "20.15.240.70", cacheStatus: "HIT", country: "US" },
        { path: "/resources/other", ua: "ChatGPT-User/1.0", ip: "1.2.3.4" },
        { path: "/resources/nope", ua: "Mozilla/5.0 Chrome" },
      ],
      { ranges, salt: "s", now },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: "/resources/sso-vs-scim", bot_family: "chatgpt-user", purpose: "live_fetch", verified: true, cache_status: "HIT", country: "US", source: "worker" });
    expect(rows[0]!.ip_hash).toHaveLength(24);
    expect(JSON.stringify(rows)).not.toContain("20.15.240.70");
    expect(rows[1]!.verified).toBe(false);
  });
  it("trusts a declared family, clamps bad timestamps and honours the default source", () => {
    const rows = prepareCrawlRows(
      [
        { path: "/a", botFamily: "gptbot", ts: "2020-01-01T00:00:00Z" },
        { path: "/b", botFamily: "unknown-bot", ts: "garbage" },
      ],
      { ranges, salt: "s", now, defaultSource: "origin" },
    );
    expect(rows[0]).toMatchObject({ bot_family: "gptbot", purpose: "train", source: "origin" });
    expect(rows[0]!.ts.toISOString()).toBe(now.toISOString());
    expect(rows[1]).toMatchObject({ bot_family: "unknown-bot", purpose: "other" });
  });
});

describe("crawlIngestSchema", () => {
  it("caps a batch at 500 and requires a site id", () => {
    expect(crawlIngestSchema.safeParse({ siteId: SITE, events: [] }).success).toBe(false);
    expect(crawlIngestSchema.safeParse({ siteId: "nope", events: [{ path: "/" }] }).success).toBe(false);
    expect(crawlIngestSchema.safeParse({ siteId: SITE, events: Array.from({ length: 501 }, () => ({ path: "/" })) }).success).toBe(false);
    expect(crawlIngestSchema.safeParse({ siteId: SITE, events: [{ path: "/x", ua: "GPTBot", ip: "1.1.1.1" }] }).success).toBe(true);
  });

  it("accepts a Worker version token and nothing that is not one", () => {
    const events = [{ path: "/x" }];
    expect(crawlIngestSchema.safeParse({ siteId: SITE, workerVersion: "2", events }).success).toBe(true);
    expect(crawlIngestSchema.safeParse({ siteId: SITE, workerVersion: "2'; drop table x", events }).success).toBe(false);
    expect(crawlIngestSchema.safeParse({ siteId: SITE, workerVersion: "x".repeat(17), events }).success).toBe(false);
  });
});

describe("noteWorkerVersion", () => {
  it("stamps the site at most once a minute, and at once when the version changes", async () => {
    resetWorkerVersionMemo();
    const sql = fakeSql([[/update app\.sites set worker_version/, () => [{ id: SITE }]]]);
    const t0 = now.getTime();
    expect(await noteWorkerVersion(SITE, "2", sql, t0)).toBe(true);
    expect(await noteWorkerVersion(SITE, "2", sql, t0 + 30_000)).toBe(false);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]!.text).toContain("worker_seen_at < now() - interval '1 minute'");
    expect(sql.queries[0]!.values.slice(0, 2)).toEqual(["2", SITE]);
    await noteWorkerVersion(SITE, "3", sql, t0 + 31_000);
    await noteWorkerVersion(SITE, "3", sql, t0 + 92_000);
    expect(sql.queries).toHaveLength(3);
  });
});

describe("insertCrawlEvents", () => {
  it("writes the batch in one statement joined to the published page", async () => {
    const sql = fakeSql();
    const rows = prepareCrawlRows([{ path: "/resources/a", botFamily: "gptbot" }, { path: "/resources/b", botFamily: "ccbot" }], { ranges, salt: "s", now });
    expect(await insertCrawlEvents(SITE, rows, sql)).toBe(2);
    expect(sql.queries).toHaveLength(1);
    const q = sql.queries[0]!;
    expect(q.text).toContain("insert into analytics.crawl_events");
    expect(q.text).toContain("left join content.published_pages");
    expect(q.values[0]).toBe(SITE);
    expect(q.values[2]).toEqual({ __array: ["/resources/a", "/resources/b"] });
  });
  it("skips the round trip for an empty batch", async () => {
    const sql = fakeSql();
    expect(await insertCrawlEvents(SITE, [], sql)).toBe(0);
    expect(sql.queries).toHaveLength(0);
  });
});

describe("rollupCrawlDaily", () => {
  it("upserts by the daily key", async () => {
    const sql = fakeSql([[/insert into analytics.crawl_daily/, () => [{ n: 4 }]]]);
    expect(await rollupCrawlDaily(2, sql)).toBe(4);
    expect(sql.queries[0]!.text).toContain("on conflict (site_id, day, bot_family, source, path)");
  });
});
