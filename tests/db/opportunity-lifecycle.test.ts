import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOpportunities } from "@/lib/app/queries";
import { listRefreshItems } from "@/lib/app/refresh";
import { checkCoverage, coverageGuard } from "@/lib/pipeline/coverage";
import { createManualOpportunity, explainEV0, loadOpportunity, markOpportunity, refreshesExistingPage, scanSite, type EV0Breakdown } from "@/lib/pipeline/opportunities";
import { loadInventorySignals, queueRefreshForItem } from "@/lib/refresh/scan";

/**
 * The queue over time against the real schema (0025): rows scored before
 * EV0 brought onto its scale, work the coverage guard pointed at an existing
 * page kept there, and the refresh lifecycle the guard follows (work already
 * running on the page, a page changed recently, a protected winner, a page
 * taken down). Runs only with AEO_TEST_DATABASE_URL; everything it creates is
 * under one throwaway organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("the opportunity queue's lifecycle against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const HOST = `life-${SITE.slice(0, 8)}.test`;
  const TOPIC = randomUUID();
  const WEBFLOW = randomUUID();
  const GUIDE = randomUUID();
  const FRESH = randomUUID();
  const WINNER = randomUUID();
  const Q_LEGACY = randomUUID();
  const Q_MANUAL = randomUUID();
  const Q_GUIDE_1 = randomUUID();
  const Q_GUIDE_2 = randomUUID();
  const Q_FRESH = randomUUID();
  const Q_WINNER = randomUUID();
  const Q_CITED = randomUUID();
  const Q_ASKED = randomUUID();
  const DAY = 86_400_000;
  const url = (slug: string) => `https://${HOST}/blog/${slug}`;

  const question = (id: string, text: string, extra: { volume?: number } = {}) => sql`
    insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, topic_id, search_volume)
    values (${id}, ${SITE}, ${text}, ${text}, 'autocomplete', 'us-en', 'desktop', 30, ${TOPIC}, ${extra.volume ?? null})`;

  /** A native snapshot of the question: a rival in the AI Overview (a gap), and optionally one of our pages ranking or cited. */
  const snapshot = async (questionId: string, owned: { url: string; surface: "organic" | "ai_overview"; position: number } | null) => {
    const [s] = await sql<{ id: string }[]>`
      insert into measure.serp_snapshots (site_id, question_id, provider, locale, device, aio_triggered)
      values (${SITE}, ${questionId}, 'serpapi', 'us-en', 'desktop', true) returning id`;
    if (owned?.surface !== "ai_overview") {
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, 'ai_overview', 'https://www.okta.com/scim', 'okta.com', 1, false)`;
    }
    if (owned) {
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, ${owned.surface}, ${owned.url}, ${HOST}, ${owned.position}, true)`;
    }
  };

  const cmsItem = (id: string, slug: string, title: string, lastUpdated: Date | null) => sql`
    insert into content.cms_items (id, site_id, connection_id, external_site_id, collection_id, collection_name, collection_slug, external_id, title, slug, url, url_key, body_html, last_updated)
    values (${id}, ${SITE}, ${WEBFLOW}, 'wf', 'c1', 'Blog', 'blog', ${slug}, ${title}, ${slug}, ${url(slug)}, content.url_key(${url(slug)}), '<h2>SCIM</h2><p>SCIM keeps accounts in sync.</p>', ${lastUpdated})`;

  const oppFor = async (questionId: string) => {
    const [r] = await sql<{ id: string }[]>`select id from content.opportunities where site_id = ${SITE} and question_id = ${questionId}`;
    return (await loadOpportunity(r!.id, sql))!;
  };

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Lifecycle test', ${`life-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Lifecycle test', ${HOST}, '/resources', ${`lf-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into measure.topics (id, site_id, name, slug, priority, seed_terms) values (${TOPIC}, ${SITE}, 'SCIM', 'scim', 5, '{scim}')`;
    await sql`insert into context.context_connections (id, org_id, site_id, provider) values (${WEBFLOW}, ${ORG}, ${SITE}, 'webflow')`;
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  it("brings rows scored before EV0 onto its scale at the next scan, and a merge replaces an old score rather than comparing it", async () => {
    await question(Q_LEGACY, "what is scim provisioning", { volume: 5000 });
    await question(Q_MANUAL, "scim for startups");
    await snapshot(Q_LEGACY, null);
    // What the old weighted sum wrote: a signal at 28.5 on the gap's question, a person's request at 63, and a failed one at 90.
    const old = { demand: { value: 30, weight: 0.3, contribution: 9 }, citationGap: { value: 40, weight: 0.3, contribution: 12 } };
    await sql`insert into content.opportunities (site_id, source, title, target_query, question_id, score, score_breakdown, evidence, dedupe_key, status)
      values (${SITE}, 'signal', 'what is scim provisioning', 'what is scim provisioning', ${Q_LEGACY}, 28.5, ${sql.json(old)}, '{"demandScore": 30}', ${`question:${Q_LEGACY}`}, 'open'),
             (${SITE}, 'manual', 'old manual request', 'old manual request', null, 63, ${sql.json(old)}, '{"manual": true}', 'manual:old-manual-request', 'open'),
             (${SITE}, 'manual', 'scim for startups', 'scim for startups', ${Q_MANUAL}, 90, ${sql.json(old)}, '{"manual": true}', ${`question:${Q_MANUAL}`}, 'failed')`;

    const scan = await scanSite(SITE, sql);
    expect(scan).toMatchObject({ gaps: 1, rescored: 2 });
    const queue = await listOpportunities(SITE, 25, sql);
    // Every row in the queue now explains itself on EV0, and the order is EV0's.
    expect(queue.every((r) => explainEV0(r.score_breakdown) !== null)).toBe(true);
    expect(queue.map((r) => r.score)).toEqual([...queue.map((r) => r.score)].sort((a, b) => b - a));
    const merged = queue.find((r) => r.question_id === Q_LEGACY)!;
    // The signal was re-scored as a signal first, then the gap (a higher prior) raised it.
    expect(merged.source).toBe("signal");
    expect(merged.score_breakdown).toMatchObject({ formula: "ev0", components: { gap: { type: "aio_other_sources" }, demand: { source: "search_volume", input: 5000 } } });
    const manual = queue.find((r) => r.title === "old manual request")!;
    expect(manual.score_breakdown).toMatchObject({ formula: "ev0", components: { gap: { type: "manual" }, brandFit: { value: 1 } } });
    expect(manual.score).toBeLessThan(63);

    // A failed row asked for again: its old 90 is replaced, not kept as the larger number.
    await createManualOpportunity(SITE, { title: "scim for startups", questionId: Q_MANUAL }, sql);
    const [again] = await sql<{ status: string; score: number; score_breakdown: { formula?: string } }[]>`
      select status::text as status, score::float as score, score_breakdown from content.opportunities where site_id = ${SITE} and question_id = ${Q_MANUAL}`;
    expect(again).toMatchObject({ status: "open", score_breakdown: { formula: "ev0" } });
    expect(again!.score).toBeLessThan(90);
  });

  it("keeps a person's request merged into a scanned gap at the manual prior when the gap scan comes round again", async () => {
    await question(Q_ASKED, "scim provisioning for contractors");
    await snapshot(Q_ASKED, null);
    await scanSite(SITE, sql);
    const read = async () => (await sql<{ score: number; score_breakdown: EV0Breakdown }[]>`
      select score::float as score, score_breakdown from content.opportunities where site_id = ${SITE} and question_id = ${Q_ASKED}`)[0]!;
    const gap = await read();
    expect(gap.score_breakdown.components.gap.type).toBe("aio_other_sources");
    await createManualOpportunity(SITE, { title: "scim provisioning for contractors", questionId: Q_ASKED }, sql);
    const asked = await read();
    expect(asked.score).toBeGreaterThan(gap.score);
    expect(asked.score_breakdown.components.gap.type).toBe("manual");
    await scanSite(SITE, sql);
    expect(await read()).toEqual(asked);
    expect(await oppFor(Q_ASKED)).toMatchObject({ source: "citation_gap", evidence: { manual: true } });
  });

  it("sends one run to a page and turns away a second while the first is working on it; the refresh scan sees it in flight", async () => {
    await cmsItem(GUIDE, "scim-guide", "The SCIM guide", null);
    await question(Q_GUIDE_1, "how does scim deprovisioning work");
    await question(Q_GUIDE_2, "does scim need sso first");
    await snapshot(Q_GUIDE_1, { url: url("scim-guide"), surface: "organic", position: 3 });
    await snapshot(Q_GUIDE_2, { url: url("scim-guide"), surface: "organic", position: 3 });
    await scanSite(SITE, sql);

    const first = await oppFor(Q_GUIDE_1);
    await markOpportunity(first.id, "in_progress", sql);
    expect(await coverageGuard(first, sql)).toMatchObject({ proceed: true, actionType: "refresh", evidence: { cmsItemId: GUIDE } });
    const [inventory] = await loadInventorySignals(SITE, sql, { itemId: GUIDE });
    expect(inventory!.in_flight).toBe(true);
    // The Refresh page shows that run on the post (so no "Refresh now"), and "Refresh now" hands it back rather than opening a second.
    const [onPage] = (await listRefreshItems(SITE, 500, sql)).filter((r) => r.id === GUIDE);
    expect(onPage).toMatchObject({ opportunity_id: first.id, opportunity_status: "in_progress" });
    expect(await queueRefreshForItem(GUIDE, sql)).toEqual({ id: first.id, status: "in_progress" });
    const [refreshRows] = await sql<{ n: number }[]>`select count(*)::int as n from content.opportunities where site_id = ${SITE} and source = 'refresh'`;
    expect(refreshRows!.n).toBe(0);

    const second = await oppFor(Q_GUIDE_2);
    await markOpportunity(second.id, "in_progress", sql);
    expect(await coverageGuard(second, sql)).toMatchObject({ proceed: false, dismissReason: "auto_coverage", reason: expect.stringContaining("already queued or running") });
    expect(await oppFor(Q_GUIDE_2)).toMatchObject({ status: "dismissed", action_type: "new_page" });
  });

  it("keeps work the guard pointed at a page on that page when a person reopens it and the next scan re-scores it", async () => {
    const first = await oppFor(Q_GUIDE_1);
    await markOpportunity(first.id, "failed", sql, "draft failed QA");
    await createManualOpportunity(SITE, { title: "how does scim deprovisioning work", questionId: Q_GUIDE_1 }, sql);
    expect(await oppFor(Q_GUIDE_1)).toMatchObject({ status: "open", action_type: "refresh", evidence: { cmsItemId: GUIDE } });
    await scanSite(SITE, sql);
    const after = await oppFor(Q_GUIDE_1);
    expect(after).toMatchObject({ status: "open", action_type: "refresh", evidence: { cmsItemId: GUIDE } });
    // So its next run drafts from the live post rather than a blank page.
    expect(refreshesExistingPage(after)).toBe(true);
  });

  it("does not rewrite a page changed recently, and gives a protected winner a figures-and-dates update", async () => {
    const now = new Date();
    await cmsItem(FRESH, "scim-checklist", "The SCIM checklist", new Date(now.getTime() - 10 * DAY));
    await cmsItem(WINNER, "scim-vendors", "Choosing a SCIM vendor", new Date(now.getTime() - 200 * DAY));
    await question(Q_FRESH, "what goes in a scim rollout checklist");
    await question(Q_WINNER, "which scim vendors support okta");
    await question(Q_CITED, "how to evaluate scim vendors");
    await snapshot(Q_FRESH, { url: url("scim-checklist"), surface: "organic", position: 5 });
    await snapshot(Q_WINNER, { url: url("scim-vendors"), surface: "organic", position: 2 });
    // The vendor page is cited in Google's AI Overview on another question, and holds its clicks.
    await snapshot(Q_CITED, { url: url("scim-vendors"), surface: "ai_overview", position: 1 });
    await sql`insert into measure.external_metrics (site_id, provider, surface, dimension, date, metrics) values
      (${SITE}, 'gsc', 'gsc_page_window', ${sql.json({ page: url("scim-vendors"), window: "current" })}, current_date - 1, ${sql.json({ clicks: 300, impressions: 9000, position: 2.1 })}),
      (${SITE}, 'gsc', 'gsc_page_window', ${sql.json({ page: url("scim-vendors"), window: "previous" })}, current_date - 1, ${sql.json({ clicks: 290, impressions: 8800, position: 2.3 })})`;
    await scanSite(SITE, sql);

    const fresh = await oppFor(Q_FRESH);
    await markOpportunity(fresh.id, "in_progress", sql);
    expect(await coverageGuard(fresh, sql)).toMatchObject({ proceed: false, dismissReason: "auto_coverage", reason: expect.stringContaining("changed 10 days ago, too recently to rewrite") });
    // The wait passes: a scan within it leaves the work dismissed, the first after it brings it back for the guard to look again.
    const state = async () => (await sql<{ status: string; dismiss_reason: string | null; action_type: string }[]>`
      select status::text as status, dismiss_reason::text as dismiss_reason, action_type::text as action_type from content.opportunities where id = ${fresh.id}`)[0];
    await scanSite(SITE, sql);
    expect(await state()).toEqual({ status: "dismissed", dismiss_reason: "auto_coverage", action_type: "new_page" });
    await sql`update content.opportunities set updated_at = now() - interval '46 days' where id = ${fresh.id}`;
    await scanSite(SITE, sql);
    expect(await state()).toEqual({ status: "open", dismiss_reason: null, action_type: "new_page" });

    const winner = await oppFor(Q_WINNER);
    await markOpportunity(winner.id, "in_progress", sql);
    expect(await coverageGuard(winner, sql)).toMatchObject({ proceed: true, actionType: "update_stats", evidence: { cmsItemId: WINNER, protectedWinner: true } });
    expect(await oppFor(Q_WINNER)).toMatchObject({ action_type: "update_stats" });
  });

  it("never sends work to a page someone took down", async () => {
    const [item] = await sql<{ id: string }[]>`
      insert into content.content_items (org_id, site_id, slug, title, status, origin, canonical_url, published_at, first_published_at)
      values (${ORG}, ${SITE}, 'sso-vs-scim', 'SSO vs SCIM', 'published', 'pipeline', ${`https://${HOST}/resources/sso-vs-scim`}, now() - interval '100 days', now() - interval '100 days')
      returning id`;
    await sql`insert into content.published_pages (site_id, path, content_item_id, html, etag, status) values (${SITE}, '/resources/sso-vs-scim', ${item!.id}, '<p>gone</p>', '"e"', 'retired')`;
    const verdict = await checkCoverage({ site_id: SITE, question_id: null, title: "SSO vs SCIM: what is the difference?", target_query: "sso vs scim" }, sql);
    expect(verdict).toMatchObject({ actionType: "setup_task", hit: { kind: "title_match", contentItemId: item!.id, takenDown: "retired" } });
    expect(verdict.hit!.reason).toContain("and it was taken down (retired)");
    // Live again, it is a page to refresh.
    await sql`update content.published_pages set status = 'live' where content_item_id = ${item!.id}`;
    expect(await checkCoverage({ site_id: SITE, question_id: null, title: "SSO vs SCIM: what is the difference?", target_query: "sso vs scim" }, sql)).toMatchObject({ actionType: "refresh", hit: { takenDown: null } });
  });
});
