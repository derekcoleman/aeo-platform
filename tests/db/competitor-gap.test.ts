import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trackTopQuestions } from "@/lib/app/demand";
import { autoTrackQuestions } from "@/lib/demand/store";
import { postgresSpendGovernor } from "@/lib/ops/spend";
import { coverageGuard } from "@/lib/pipeline/coverage";
import { loadOpportunity, upsertOpportunities, type EV0Breakdown } from "@/lib/pipeline/opportunities";
import { postgresBudget } from "@/lib/serp/budget";
import { postgresCache } from "@/lib/serp/cache";
import { rankedKeywordsCacheKey, rankedKeywordsCached, type DataForSeoLabs, type RankedKeyword, type RankedKeywordsQuery } from "@/lib/serp/dataforseo-labs";
import { computeOrganicGap, listCompetitorGap, loadGapPlan, persistOrganicGap, sitesForCompetitorGap, type DomainKeywords, type GapTarget } from "@/lib/strategy/competitor-gap";

/**
 * The competitor organic gap against the real schema (0026/0027): the plan's
 * competitor query, the bulk question upsert, the keyword rows and their
 * scope trigger, a later run replacing only what it fetched, the card's read
 * model (a failed fetch's rows shown for one missed run), the
 * striking-distance page in the coverage guard (and only a page
 * it can refresh, from the gap's own evidence), picking by demand passing
 * the gap's keywords over, and the month's Labs cache paid through the SERP
 * budget. Runs only with
 * AEO_TEST_DATABASE_URL; everything it creates is under one throwaway
 * organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("competitor organic gap against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const PAUSED = randomUUID();
  const TAG = SITE.slice(0, 8);
  const HOST = `gap-${TAG}.test`;
  const RIVAL = `rival-${TAG}.test`;
  const OTHER = `other-${TAG}.test`;
  const E_RIVAL = randomUUID();
  const E_OTHER = randomUUID();
  const E_SEEDED = randomUUID();
  const TOPIC = randomUUID();
  const WEBFLOW = randomUUID();
  const CMS = randomUUID();
  const Q_PRICING = randomUUID();
  const Q_SETUP = randomUUID();
  const Q_AIO = randomUUID();
  const labsKey = (q: RankedKeywordsQuery) => rankedKeywordsCacheKey(q, "2026-10");

  const kw = (keyword: string, rank: number, over: Partial<RankedKeyword> = {}): RankedKeyword => ({
    keyword, searchVolume: 100, keywordDifficulty: 30, searchIntent: "informational", rank, url: `https://${RIVAL}/${keyword.replace(/\s+/g, "-")}`, ...over,
  });
  const own: DomainKeywords = { domain: HOST, truncated: false, keywords: [kw("sso pricing", 14, { searchVolume: 880, url: `https://${HOST}/blog/sso-pricing` })] };
  const rival = (keywords: RankedKeyword[]): DomainKeywords & GapTarget => ({ domain: RIVAL, entityId: E_RIVAL, name: "Rival", truncated: false, keywords });
  const other = (keywords: RankedKeyword[]): DomainKeywords & GapTarget => ({ domain: OTHER, entityId: E_OTHER, name: "Other", truncated: false, keywords });

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Gap test', ${`gap-${TAG}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status, locale) values
      (${SITE}, ${ORG}, 'Gap test', ${`www.${HOST}`}, '/resources', ${`gap-${TAG}.blogedge.test`}, 'active', 'en-US'),
      (${PAUSED}, ${ORG}, 'Gap paused', ${`paused-${TAG}.test`}, '/resources', ${`gap-paused-${TAG}.blogedge.test`}, 'paused', 'en-US')`;
    await sql`insert into measure.topics (id, site_id, name, slug, priority, seed_terms) values (${TOPIC}, ${SITE}, 'SSO', 'sso', 4, '{sso,saml}')`;
    await sql`insert into context.entities (id, org_id, type, name, aliases, domains, metadata) values
      (${E_RIVAL}, ${ORG}, 'competitor', 'Rival', '{}', ${[RIVAL]}, '{}'),
      (${E_OTHER}, ${ORG}, 'competitor', 'Other', '{}', ${[OTHER]}, '{}'),
      (${E_SEEDED}, ${ORG}, 'competitor', 'Aardvark', '{}', ${[`seeded-${TAG}.test`]}, ${sql.json({ seeded_from: "topic" })})`;
    await sql`insert into context.context_connections (id, org_id, site_id, provider) values (${WEBFLOW}, ${ORG}, ${SITE}, 'webflow')`;
    await sql`insert into content.cms_items (id, site_id, connection_id, external_site_id, collection_id, collection_name, collection_slug, external_id, title, slug, url, url_key, body_html)
      values (${CMS}, ${SITE}, ${WEBFLOW}, 'wf', 'c1', 'Blog', 'blog', 'i1', 'SSO pricing explained', 'sso-pricing',
              ${`https://www.${HOST}/blog/sso-pricing/`}, content.url_key(${`https://www.${HOST}/blog/sso-pricing/`}), '<p>What SSO costs.</p>')`;
    // A question a person already tracks and pinned, and one they excluded.
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, is_tracked, tracking_tier, pinned) values
      (${Q_PRICING}, ${SITE}, 'sso pricing', 'sso pricing', 'manual', 'us-en', 'desktop', 50, true, 'weekly', true)`;
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, excluded) values
      (${Q_SETUP}, ${SITE}, 'saml setup', 'saml setup', 'autocomplete', 'us-en', 'desktop', 20, true)`;
  });

  afterAll(async () => {
    await sql`delete from measure.serp_cache where key = ${labsKey({ target: RIVAL, locale: { country: "us", language: "en" }, maxRank: 10 })}`;
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  it("plans the confirmed competitors' domains before a seeded one, for tracked sites only", async () => {
    const r = await loadGapPlan(SITE, ORG, sql, new Date("2026-10-02T11:00:00Z"));
    if (!("plan" in r)) throw new Error(`expected a plan, got ${JSON.stringify(r)}`);
    expect(r.plan).toMatchObject({ brand: HOST, locale: "us-en", month: "2026-10" });
    expect(r.plan.competitors.map((c) => c.domain)).toEqual([OTHER, RIVAL, `seeded-${TAG}.test`]);
    expect(await loadGapPlan(PAUSED, ORG, sql)).toEqual({ skipped: "site is paused" });
    const sites = (await sitesForCompetitorGap(sql)).filter((s) => s.org_id === ORG);
    expect(sites).toEqual([{ site_id: SITE, org_id: ORG }]);
  });

  it("stores the gap: questions, the card's rows and EV0 opportunities", async () => {
    const gap = computeOrganicGap(own, [
      rival([kw("sso pricing", 3, { searchVolume: 880, searchIntent: "commercial" }), kw("saml setup", 2), kw("best sso tools", 5, { searchVolume: 1600, searchIntent: "commercial" }), kw("pizza recipes", 1, { searchVolume: 5000 })]),
      other([kw("best sso tools", 1, { searchVolume: 1600, searchIntent: "commercial", url: `https://${OTHER}/tools` })]),
    ]);
    const out = await persistOrganicGap({ siteId: SITE, locale: "us-en", gap, fetchedDomains: [RIVAL, OTHER], plannedDomains: [RIVAL, OTHER], fetchedAt: "2026-10-02T11:00:00Z" }, sql);
    expect(out).toMatchObject({ questions: 4, keywords: 5, opportunities: { considered: 3, belowFloor: 1, inserted: 2 } });

    const qs = await sql<{ text: string; source: string; is_tracked: boolean; pinned: boolean; excluded: boolean; search_volume: number | null; search_intent: string | null; topic_id: string | null; demand_score: number }[]>`
      select text, source::text as source, is_tracked, pinned, excluded, search_volume, search_intent, topic_id, demand_score::float as demand_score
      from measure.questions where site_id = ${SITE} order by text`;
    expect(qs).toEqual([
      { text: "best sso tools", source: "competitor", is_tracked: false, pinned: false, excluded: false, search_volume: 1600, search_intent: "commercial", topic_id: TOPIC, demand_score: 0 },
      { text: "pizza recipes", source: "competitor", is_tracked: false, pinned: false, excluded: false, search_volume: 5000, search_intent: "informational", topic_id: null, demand_score: 0 },
      // An existing question keeps its source, tracking, pin, exclusion and score; it gains the keyword data.
      { text: "saml setup", source: "autocomplete", is_tracked: false, pinned: false, excluded: true, search_volume: 100, search_intent: "informational", topic_id: TOPIC, demand_score: 20 },
      { text: "sso pricing", source: "manual", is_tracked: true, pinned: true, excluded: false, search_volume: 880, search_intent: "commercial", topic_id: TOPIC, demand_score: 50 },
    ]);

    const rows = await sql<{ domain: string; keyword: string; org_id: string; rank: number; brand_rank: number | null; question_id: string | null }[]>`
      select domain, keyword, org_id, rank, brand_rank, question_id from measure.competitor_keywords where site_id = ${SITE} order by keyword, domain`;
    expect(rows.map((r) => [r.domain, r.keyword, r.rank, r.brand_rank])).toEqual([
      [OTHER, "best sso tools", 1, null], [RIVAL, "best sso tools", 5, null], [RIVAL, "pizza recipes", 1, null], [RIVAL, "saml setup", 2, null], [RIVAL, "sso pricing", 3, 14],
    ]);
    expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([ORG]));
    expect(rows.find((r) => r.keyword === "sso pricing")!.question_id).toBe(Q_PRICING);

    const opps = await sql<{ title: string; source: string; status: string; action_type: string; score_breakdown: EV0Breakdown; evidence: Record<string, unknown> }[]>`
      select title, source::text as source, status::text as status, action_type::text as action_type, score_breakdown, evidence
      from content.opportunities where site_id = ${SITE} order by score desc`;
    expect(opps.map((o) => [o.title, o.source, o.status, o.action_type])).toEqual([["best sso tools", "competitor", "open", "new_page"], ["sso pricing", "competitor", "open", "new_page"]]);
    expect(opps[0]!.score_breakdown.components.gap).toEqual({ type: "organic_competitor", prior: 0.4 });
    expect(opps[1]!.evidence).toMatchObject({ brandRank: 14, brandUrl: `https://${HOST}/blog/sso-pricing`, strikingDistance: true });
  });

  it("the card groups by keyword, best rank first, buyer intent first, and hides excluded questions", async () => {
    const card = await listCompetitorGap(SITE, {}, sql);
    expect(card.map((r) => r.keyword)).toEqual(["best sso tools", "sso pricing", "pizza recipes"]);
    expect(card[0]!.competitors.map((c) => [c.name, c.rank])).toEqual([["Other", 1], ["Rival", 5]]);
    expect(card[1]).toMatchObject({ brand_rank: 14, opportunity_status: "open", question_id: Q_PRICING, locale: "us-en" });
    expect((await listCompetitorGap(SITE, { topicId: TOPIC }, sql)).map((r) => r.keyword)).toEqual(["best sso tools", "sso pricing"]);
  });

  it("sends striking-distance work to the page that ranks, not a second page", async () => {
    const [o] = await sql<{ id: string }[]>`select id from content.opportunities where site_id = ${SITE} and question_id = ${Q_PRICING}`;
    const r = await coverageGuard((await loadOpportunity(o!.id, sql))!, sql);
    expect(r).toMatchObject({ proceed: true, actionType: "refresh", evidence: { cmsItemId: CMS, coverage: { kind: "keyword_rank", measure: 14 } } });
  });

  it("a later run replaces the domains it fetched, keeps a failed fetch's rows for one missed run, and drops a domain it no longer covers", async () => {
    const keywords = async () =>
      (await sql<{ domain: string; keyword: string }[]>`select domain, keyword from measure.competitor_keywords where site_id = ${SITE} order by domain, keyword`).map((r) => `${r.domain === RIVAL ? "rival" : "other"}:${r.keyword}`);
    const card = async () =>
      (await listCompetitorGap(SITE, {}, sql)).map((r) => [r.keyword, r.competitors.map((c) => `${c.name} ${new Date(c.fetched_at).toISOString().slice(0, 10)}`)]);
    // The other competitor's fetch failed: only the rival's rows are replaced.
    const gap = computeOrganicGap(own, [rival([kw("sso audit", 4, { searchVolume: 300 })])]);
    await persistOrganicGap({ siteId: SITE, locale: "us-en", gap, fetchedDomains: [RIVAL], plannedDomains: [RIVAL, OTHER], fetchedAt: "2026-11-02T11:00:00Z" }, sql);
    expect(await keywords()).toEqual(["other:best sso tools", "rival:sso audit"]);
    // The card shows the other's earlier rankings, each competitor with its own fetch.
    expect(await card()).toEqual([["best sso tools", ["Other 2026-10-02"]], ["sso audit", ["Rival 2026-11-02"]]]);
    // It fails again: its rows are kept, but two runs old they are no longer shown.
    await persistOrganicGap({ siteId: SITE, locale: "us-en", gap, fetchedDomains: [RIVAL], plannedDomains: [RIVAL, OTHER], fetchedAt: "2026-12-02T11:00:00Z" }, sql);
    expect(await keywords()).toEqual(["other:best sso tools", "rival:sso audit"]);
    expect(await card()).toEqual([["sso audit", ["Rival 2026-12-02"]]]);
    // The other is no longer planned (a competitor past the cap, or its domain removed).
    await persistOrganicGap({ siteId: SITE, locale: "us-en", gap, fetchedDomains: [RIVAL], plannedDomains: [RIVAL], fetchedAt: "2026-12-02T11:00:00Z" }, sql);
    expect(await keywords()).toEqual(["rival:sso audit"]);
  });

  it("a competitor removed since is gone from the card at once", async () => {
    expect((await listCompetitorGap(SITE, {}, sql)).map((r) => r.keyword)).toEqual(["sso audit"]);
    await sql`update context.entities set type = 'other', domains = '{}' where id = ${E_RIVAL}`;
    expect(await listCompetitorGap(SITE, {}, sql)).toEqual([]);
    await sql`update context.entities set type = 'competitor', domains = ${[RIVAL]} where id = ${E_RIVAL}`;
  });

  it("caches a domain's rankings for the month and pays through the org's SERP budget", async () => {
    const q: RankedKeywordsQuery = { target: RIVAL, locale: { country: "us", language: "en" }, maxRank: 10 };
    let calls = 0;
    const labs: DataForSeoLabs = {
      estimateUsd: 0.12,
      async rankedKeywords() {
        calls++;
        return { provider: "dataforseo", target: RIVAL, locationCode: 2840, languageCode: "en", localeFallback: false, maxRank: 10, total: 1, truncated: false, keywords: [kw("sso audit", 4)], fetchedAt: new Date().toISOString(), costUsd: 0.1 };
      },
    };
    const deps = { labs, cache: postgresCache(sql), budget: postgresBudget(sql, postgresSpendGovernor(sql, { env: {}, onAlert: async () => undefined })), month: "2026-10" };
    const tenant = { orgId: ORG, siteId: SITE };
    expect((await rankedKeywordsCached(q, tenant, deps)).cached).toBe(false);
    const again = await rankedKeywordsCached(q, tenant, deps);
    expect(again).toMatchObject({ cached: true, keywords: [{ keyword: "sso audit", rank: 4 }] });
    expect(calls).toBe(1);
    const [cached] = await sql<{ provider: string; method: string; query: string; day: string; cost_usd: number }[]>`
      select provider::text as provider, method, query, day::text as day, cost_usd::float as cost_usd from measure.serp_cache where key = ${labsKey(q)}`;
    expect(cached).toEqual({ provider: "dataforseo", method: "labs.ranked_keywords", query: RIVAL, day: "2026-10-01", cost_usd: 0.1 });
    const spend = await sql<{ method: string; cost_usd: number; cached: boolean }[]>`
      select method, cost_usd::float as cost_usd, cached from measure.serp_spend where org_id = ${ORG} order by at, id`;
    expect(spend).toEqual([{ method: "labs.ranked_keywords", cost_usd: 0.1, cached: false }, { method: "labs.ranked_keywords", cost_usd: 0, cached: true }]);
    const [hold] = await sql<{ status: string; actual_usd: number }[]>`
      select status, actual_usd::float as actual_usd from ops.spend_reservations where org_id = ${ORG} and resource = 'serp'`;
    expect(hold).toEqual({ status: "settled", actual_usd: 0.1 });
  });
  it("picking by demand passes over the gap's keywords until the miner finds them", async () => {
    const tracked = async () =>
      (await sql<{ text: string }[]>`select text from measure.questions where site_id = ${SITE} and is_tracked order by text`).map((r) => r.text);
    // Three competitor keywords at demand 0 and room for ten: neither picks them.
    expect(await autoTrackQuestions(SITE, 10, sql)).toBe(0);
    expect(await trackTopQuestions(SITE, 10, "weekly", sql)).toBe(1);
    expect(await tracked()).toEqual(["sso pricing"]);
    // The miner finds one (its upsert keeps the higher demand): it is discovery's now.
    await sql`update measure.questions set demand_score = greatest(demand_score, 12) where site_id = ${SITE} and normalized = 'best sso tools'`;
    expect(await autoTrackQuestions(SITE, 10, sql)).toBe(1);
    expect(await tracked()).toEqual(["best sso tools", "sso pricing"]);
  });

  it("a ranking page it cannot refresh never dismisses work, the AI Overview gap's included", async () => {
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, topic_id) values
      (${Q_AIO}, ${SITE}, 'sso compliance', 'sso compliance', 'autocomplete', 'us-en', 'desktop', 30, ${TOPIC})`;
    await upsertOpportunities(SITE, [{
      source: "citation_gap", title: "sso compliance", targetQuery: "sso compliance", questionId: Q_AIO, topicId: TOPIC, score: 20,
      scoreBreakdown: { formula: "ev0" }, evidence: { snapshotId: "s1", namedCompetitors: 1 }, dedupeKey: `question:${Q_AIO}`,
    }], sql);
    // The site ranks 15 with a product page outside the CMS, and 16 with its home page.
    const gap = computeOrganicGap(
      { domain: HOST, truncated: false, keywords: [kw("sso compliance", 15, { url: `https://www.${HOST}/product/compliance` }), kw("sso checklist", 16, { url: `https://www.${HOST}/` })] },
      [rival([kw("sso compliance", 2, { searchVolume: 500, searchIntent: "commercial" }), kw("sso checklist", 3, { searchVolume: 400 })])],
    );
    const out = await persistOrganicGap({ siteId: SITE, locale: "us-en", gap, fetchedDomains: [RIVAL], plannedDomains: [RIVAL], fetchedAt: "2027-01-02T11:00:00Z" }, sql);
    expect(out.opportunities).toMatchObject({ inserted: 1, updated: 1 });

    const opps = await sql<{ id: string; title: string; source: string; evidence: Record<string, unknown> }[]>`
      select id, title, source::text as source, evidence from content.opportunities
      where site_id = ${SITE} and title in ('sso compliance', 'sso checklist') order by title desc`;
    expect(opps.map((o) => [o.title, o.source])).toEqual([["sso compliance", "citation_gap"], ["sso checklist", "competitor"]]);
    // The merge carries the gap's page onto the AI Overview gap's row.
    expect(opps[0]!.evidence).toMatchObject({ snapshotId: "s1", brandUrl: `https://www.${HOST}/product/compliance`, bySource: { competitor: { brandRank: 15 } } });

    for (const o of opps) {
      expect(await coverageGuard((await loadOpportunity(o.id, sql))!, sql)).toMatchObject({ proceed: true, actionType: "new_page", checked: true });
    }
    const after = await sql<{ status: string; action_type: string }[]>`
      select status::text as status, action_type::text as action_type from content.opportunities where id in ${sql(opps.map((o) => o.id))}`;
    expect(after).toEqual([{ status: "open", action_type: "new_page" }, { status: "open", action_type: "new_page" }]);
  });
});
