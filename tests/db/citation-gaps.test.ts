import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentRestatements, METHODOLOGY_PAGE_METRICS, METHODOLOGY_VERSION, RESTATED_METRICS } from "@/lib/app/methodology";
import { DEMAND_GAP_LIMIT } from "@/lib/app/demand";
import { computeRestatement } from "@/lib/app/restatement";
import { citationGaps } from "@/lib/demand/store";
import { citationStatus } from "@/lib/pipeline/loop";
import { topicStats } from "@/lib/strategy/topics";

/**
 * Citation gaps against the real schema: a gap is judged on the latest
 * snapshot from our own trackers, within 45 days, whatever it showed. Also
 * the restatement of the numbers the pages showed, the old way and the new.
 * Runs only with AEO_TEST_DATABASE_URL; everything it creates is under one
 * throwaway organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("citation gaps against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const TOPIC = randomUUID();
  const Q = { closed: randomUUID(), profoundNewer: randomUUID(), stale: randomUUID(), owned: randomUUID(), excluded: randomUUID() };
  const TOPICLESS = randomUUID();

  async function snapshot(questionId: string, provider: string, daysAgo: number, aio: boolean, cites: { domain: string; owned: boolean }[]) {
    const [s] = await sql<{ id: string }[]>`
      insert into measure.serp_snapshots (site_id, question_id, provider, fetched_at, locale, device, aio_triggered)
      values (${SITE}, ${questionId}, ${provider}, now() - make_interval(days => ${daysAgo}), 'us-en', 'desktop', ${aio})
      returning id`;
    for (const [i, c] of cites.entries()) {
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, 'ai_overview', ${`https://${c.domain}/x`}, ${c.domain}, ${i + 1}, ${c.owned})`;
    }
  }

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Gaps test', ${`gaps-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Gaps test', 'acme-gaps.test', '/resources', ${`gp-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into measure.topics (id, site_id, name, slug, priority) values (${TOPIC}, ${SITE}, 'SCIM', 'scim', 3)`;
    for (const [name, id] of Object.entries(Q)) {
      await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, topic_id, excluded)
        values (${id}, ${SITE}, ${name}, ${name}, 'autocomplete', 'us-en', 'desktop', 10, ${TOPIC}, ${name === "excluded"})`;
    }
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score)
      values (${TOPICLESS}, ${SITE}, 'topicless', 'topicless', 'autocomplete', 'us-en', 'desktop', 5)`;
    const rival = [{ domain: "rival.com", owned: false }];
    // A gap ten days ago, closed by a newer snapshot with no AI Overview.
    await snapshot(Q.closed, "serpapi", 10, true, rival);
    await snapshot(Q.closed, "serpapi", 2, false, []);
    // A native gap, then a newer Profound answer that cites us: another engine, so the gap stays open.
    await snapshot(Q.profoundNewer, "dataforseo", 5, true, rival);
    await snapshot(Q.profoundNewer, "profound", 1, true, [{ domain: "acme-gaps.test", owned: true }]);
    // Too old to be work: past the 45-day window.
    await snapshot(Q.stale, "serpapi", 50, true, rival);
    // We are cited alongside the rival: no gap.
    await snapshot(Q.owned, "serpapi", 3, true, [...rival, { domain: "acme-gaps.test", owned: true }]);
    // A real gap on a question the customer excluded.
    await snapshot(Q.excluded, "serpapi", 3, true, rival);
    // A real gap on no topic: on Demand's list, never on a Strategy topic card.
    await snapshot(TOPICLESS, "serpapi", 4, true, rival);
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  it("lists only fresh, native, still-open gaps on questions that are not excluded", async () => {
    const gaps = await citationGaps(SITE, 50, sql);
    expect(gaps.map((g) => g.question_id)).toEqual([Q.profoundNewer, TOPICLESS]);
    expect(gaps[0]).toMatchObject({ provider: "dataforseo", competitor_domains: ["rival.com"] });
    expect((await topicStats(SITE, sql)).get(TOPIC)).toMatchObject({ gaps: 1 });
  });

  it("the post-publish check reads the native snapshot, not a newer Profound one", async () => {
    expect(await citationStatus(Q.profoundNewer, SITE, sql)).toMatchObject({ aioTriggered: true, owned: false, competitorDomains: ["rival.com"] });
  });

  it("restates the numbers the pages showed: the old way, the new way, and why", async () => {
    const rows = await computeRestatement(SITE, sql);
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, [r.oldValue, r.newValue]]));
    expect(Object.keys(byMetric).sort()).toEqual(Object.keys(RESTATED_METRICS).sort());
    // Demand's list, old: the newest AIO snapshot per question, however old (closed, newer-Profound, stale, topicless).
    expect(byMetric.open_gaps).toEqual([4, 2]);
    // Strategy's topic cards, old: the latest native snapshot (so "closed" was already closed), but stale and excluded counted.
    expect(byMetric.topic_gaps).toEqual([3, 1]);
    // Demand's 7-day count, old: Profound's synced row counted with ours.
    expect(byMetric.snapshots_7d).toEqual([6, 5]);
    const shown = await currentRestatements(SITE, ["open_gaps", "topic_gaps", "snapshots_7d"], sql);
    expect(shown.map((r) => [r.metric, r.old_value, r.new_value, r.methodology_version]).sort()).toEqual([
      ["open_gaps", 4, 2, METHODOLOGY_VERSION],
      ["snapshots_7d", 6, 5, METHODOLOGY_VERSION],
      ["topic_gaps", 3, 1, METHODOLOGY_VERSION],
    ]);
    // Each page names only its own figures.
    expect((await currentRestatements(SITE, METHODOLOGY_PAGE_METRICS.strategy, sql)).map((r) => r.metric)).toEqual(["topic_gaps"]);
    // Re-running replaces the rows rather than adding to them.
    await computeRestatement(SITE, sql);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from app.metric_restatements where site_id = ${SITE}`;
    expect(n!.n).toBe(Object.keys(RESTATED_METRICS).length);
    // A metric the new method did not move is recorded but not shown.
    expect((await currentRestatements(SITE, null, sql)).map((r) => r.metric)).not.toContain("gsc_clicks_28d");
  });

  it("announces no move on a page whose numbers did not change", async () => {
    // Profound's newer answer cites us, but the AI Overview cards were native
    // before and after: Attribution has nothing to restate.
    await computeRestatement(SITE, sql);
    expect(await currentRestatements(SITE, METHODOLOGY_PAGE_METRICS.attribution, sql)).toEqual([]);
  });
});

describe.skipIf(!DB_URL)("open-gap restatement against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const ORG = randomUUID();
  const SITE = randomUUID();

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Gap cap test', ${`gapcap-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Gap cap test', 'acme-gapcap.test', '/resources', ${`gc-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    // More gaps than Demand lists, under the old rule and the new; two are closed by a newer snapshot.
    for (let i = 0; i < DEMAND_GAP_LIMIT + 3; i++) {
      const [q] = await sql<{ id: string }[]>`
        insert into measure.questions (site_id, text, normalized, source, locale, device, demand_score)
        values (${SITE}, ${`q${i}`}, ${`q${i}`}, 'autocomplete', 'us-en', 'desktop', 10) returning id`;
      const [s] = await sql<{ id: string }[]>`
        insert into measure.serp_snapshots (site_id, question_id, provider, fetched_at, locale, device, aio_triggered)
        values (${SITE}, ${q!.id}, 'serpapi', now() - interval '10 days', 'us-en', 'desktop', true) returning id`;
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, 'ai_overview', 'https://rival.com/x', 'rival.com', 1, false)`;
      if (i < 2) {
        await sql`insert into measure.serp_snapshots (site_id, question_id, provider, fetched_at, locale, device, aio_triggered)
          values (${SITE}, ${q!.id}, 'serpapi', now() - interval '1 day', 'us-en', 'desktop', false)`;
      }
    }
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  it("restates the figure Demand shows, which stops at the list's length, so no move is announced that the badge never made", async () => {
    const byMetric = Object.fromEntries((await computeRestatement(SITE, sql)).map((r) => [r.metric, [r.oldValue, r.newValue]]));
    // 33 → 31 underneath; the badge read 30 before and reads 30 now.
    expect(byMetric.open_gaps).toEqual([DEMAND_GAP_LIMIT, DEMAND_GAP_LIMIT]);
    expect((await currentRestatements(SITE, METHODOLOGY_PAGE_METRICS.demand, sql)).map((r) => r.metric)).not.toContain("open_gaps");
  });
});
