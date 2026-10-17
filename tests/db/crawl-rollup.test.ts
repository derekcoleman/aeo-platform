import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollupCrawlDaily } from "@/lib/analytics/crawl";

/**
 * The hourly crawl rollup against the real schema (0010): it covers whole UTC
 * days, and a day already rolled up never loses hits when its raw events are
 * purged. Runs only with AEO_TEST_DATABASE_URL; everything it creates is under
 * one throwaway organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("crawl rollup against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
  const ORG = randomUUID();
  const SITE = randomUUID();

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Rollup test', ${`rollup-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Rollup test', ${`rollup-${SITE.slice(0, 8)}.test`}, '/resources', ${`ru-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  /** An event `days` UTC days before today, `minutes` after that day's midnight. */
  const event = (days: number, minutes: number, verified = false) => sql`
    insert into analytics.crawl_events (site_id, ts, path, bot_family, purpose, verified, source)
    values (${SITE}, (date_trunc('day', now() at time zone 'UTC') - make_interval(days => ${days}) + make_interval(mins => ${minutes})) at time zone 'UTC',
            '/resources/guide', 'gptbot', 'live_fetch', ${verified}, 'worker')`;

  const daily = async () => {
    const rows = await sql<{ ago: number; hits: number; verified_hits: number }[]>`
      select ((now() at time zone 'UTC')::date - day)::int as ago, hits, verified_hits
      from analytics.crawl_daily where site_id = ${SITE} order by day`;
    return Object.fromEntries(rows.map((r) => [r.ago, { hits: r.hits, verified: r.verified_hits }]));
  };

  it("rolls up whole UTC days and never lowers a day whose raw events were purged", async () => {
    // Two days ago at 00:05 and 23:55: a "last 48 hours" window misses the first whenever it runs after 00:05.
    await event(2, 5, true);
    await event(2, 23 * 60 + 55);
    await event(1, 12 * 60);
    await event(0, 1);
    await rollupCrawlDaily(2, sql);
    expect(await daily()).toEqual({ 2: { hits: 2, verified: 1 }, 1: { hits: 1, verified: 0 }, 0: { hits: 1, verified: 0 } });

    // Retention purges the oldest day's raw events; the next hourly run must not shrink it.
    await sql`delete from analytics.crawl_events where site_id = ${SITE} and ts < (date_trunc('day', now() at time zone 'UTC') - interval '1 day') at time zone 'UTC'`;
    await rollupCrawlDaily(2, sql);
    expect(await daily()).toEqual({ 2: { hits: 2, verified: 1 }, 1: { hits: 1, verified: 0 }, 0: { hits: 1, verified: 0 } });

    // A late event still raises its day.
    await event(1, 13 * 60, true);
    await rollupCrawlDaily(2, sql);
    expect((await daily())[1]).toEqual({ hits: 2, verified: 1 });
  });
});
