import { describe, expect, it } from "vitest";
import type { CitationGap } from "@/lib/demand/store";
import {
  ACTION_EFFORT,
  createManualOpportunity,
  defaultBusinessValue,
  demandFromVolume,
  dismissOpportunity,
  EV0_VERSION,
  ev0Demand,
  explainEV0,
  GAP_PRIORS,
  INTENT_WEIGHTS,
  isManualOpportunity,
  loadOpportunity,
  loadQuestionDemand,
  loadTopicalContext,
  markFailed,
  markOpportunity,
  NEUTRAL_BUSINESS_VALUE,
  openRefreshOpportunity,
  opportunitiesFromCitationGaps,
  opportunityKey,
  refreshesExistingPage,
  resolveIntent,
  rescoreLegacyOpportunities,
  scanSite,
  scoreEV0,
  storedEV0Input,
  TOPICAL_FIT,
  topicalContextFrom,
  topicalFit,
  topiclessValue,
  upsertOpportunities,
  type EV0Breakdown,
  type EV0Input,
  type QuestionDemand,
  type StoredOpportunity,
  type TopicWeight,
} from "@/lib/pipeline/opportunities";
import { fakeSql } from "./helpers/fake-sql";
import { ORG_ID, SITE_ID } from "./fixtures/pipeline";

const Q1 = "dddddddd-0000-0000-0000-000000000001";

const topic = (id: string, priority: number, status: TopicWeight["status"] = "active", extra: Partial<TopicWeight> = {}): [string, TopicWeight] => [id, { id, priority, formats: [], status, ...extra }];
const gap = (over: Partial<CitationGap> = {}): CitationGap => ({
  question_id: Q1, topic_id: null, text: "what is scim provisioning", demand_score: 40, snapshot_id: "s", fetched_at: "", provider: "serpapi",
  competitor_domains: ["okta.com"], named_competitor_domains: [], named_competitors: 0, ...over,
});
const parts = (o: { scoreBreakdown: Record<string, unknown> }) => (o.scoreBreakdown as unknown as EV0Breakdown).components;
const base: EV0Input = {
  demand: { demandScore: 50 },
  intent: { value: "informational", source: "default" },
  gapType: "aio_other_sources",
  topic: null,
  brandFit: { value: 1, reason: "test" },
  actionType: "new_page",
};

describe("scoreEV0", () => {
  it("is demand × intent × gap prior × business value × fit ÷ effort, with every factor in the breakdown", () => {
    const s = scoreEV0({ ...base, demand: { searchVolume: 999 }, intent: { value: "commercial", source: "provider" }, gapType: "aio_named_competitor", topic: topic("t", 4)[1], brandFit: { value: 0.6, reason: "names the seed term \"scim\"" } });
    // 75 × 1.5 × 0.6 × 0.8 × 0.6 ÷ 2
    expect(s.score).toBe(16.2);
    expect(s.breakdown).toEqual({
      formula: "ev0",
      version: EV0_VERSION,
      ev: 16.2,
      components: {
        demand: { value: 75, source: "search_volume", coldStart: false, input: 999 },
        intent: { value: "commercial", source: "provider", weight: 1.5 },
        gap: { type: "aio_named_competitor", prior: 0.6 },
        businessValue: { value: 0.8, source: "topic", priority: 4 },
        brandFit: { value: 0.6, reason: "names the seed term \"scim\"" },
        effort: { action: "new_page", value: 2 },
      },
      predictedLift: null,
    });
    expect(JSON.parse(JSON.stringify(s.breakdown))).toEqual(s.breakdown);
  });

  it("uses the published priors, intent weights and efforts", () => {
    expect(GAP_PRIORS).toEqual({ aio_named_competitor: 0.6, aio_other_sources: 0.45, organic_competitor: 0.4, unanswered_signal: 0.3, refresh_lost_citation: 0.6, refresh_decline: 0.5, refresh_stale: 0.3, manual: 1 });
    expect(INTENT_WEIGHTS).toEqual({ transactional: 1.5, commercial: 1.5, comparison: 1.3, informational: 1, navigational: 0.5 });
    expect(ACTION_EFFORT).toEqual({ update_stats: 0.5, refresh: 1, expand: 1.5, new_page: 2, consolidate: 2.5, setup_task: 1 });
  });

  it("divides by the work: the same value is worth more as a statistics update than as a new page", () => {
    const ev = (actionType: EV0Input["actionType"]) => scoreEV0({ ...base, actionType }).score;
    expect(ev("update_stats")).toBeGreaterThan(ev("refresh"));
    expect(ev("refresh")).toBeGreaterThan(ev("expand"));
    expect(ev("expand")).toBeGreaterThan(ev("new_page"));
    expect(ev("new_page")).toBeGreaterThan(ev("consolidate"));
  });

  it("values a topic at priority / 5 and a paused one as a question on no topic", () => {
    expect(scoreEV0({ ...base, topic: topic("t", 3)[1] }).breakdown.components.businessValue).toEqual({ value: 0.6, source: "topic", priority: 3 });
    expect(scoreEV0({ ...base, topic: topic("t", 5, "paused")[1], topicless: 0.2 }).breakdown.components.businessValue).toEqual({ value: 0.2, source: "topicless" });
    expect(scoreEV0({ ...base }).breakdown.components.businessValue).toEqual({ value: NEUTRAL_BUSINESS_VALUE / 100, source: "topicless" });
  });

  it("explains itself in one line, and says nothing about a breakdown from before EV0", () => {
    const s = scoreEV0({ ...base, topic: topic("t", 4)[1] });
    expect(explainEV0(s.breakdown)).toBe("demand 50 (mined, cold start) × informational 1 × AI Overview gap, other sources cited 0.45 × priority 4/5 0.8 × fit 1 ÷ new page 2 = 9");
    expect(explainEV0({ demand: { value: 50, weight: 0.3, contribution: 15 } })).toBeNull();
    expect(explainEV0(null)).toBeNull();
  });
});

describe("EV0 demand and intent", () => {
  it("takes measured volume first, then the page's impressions, then the query's, then the mined score as a cold start", () => {
    expect(demandFromVolume(0)).toBe(0);
    expect(demandFromVolume(99)).toBeCloseTo(50, 0);
    expect(demandFromVolume(10_000)).toBe(100);
    expect(ev0Demand({ searchVolume: 880, queryImpressions: 5000, demandScore: 12 })).toMatchObject({ source: "search_volume", coldStart: false, input: 880 });
    expect(ev0Demand({ searchVolume: 0, queryImpressions: 99, demandScore: 12 })).toMatchObject({ source: "gsc_query_impressions", value: 50, coldStart: false });
    // A page's own impressions of zero is a measurement: nobody sees it.
    expect(ev0Demand({ pageImpressions: 0 })).toEqual({ value: 0, source: "gsc_page_impressions", coldStart: false, input: 0 });
    // A query the site gets no impressions on only says it does not rank yet.
    expect(ev0Demand({ queryImpressions: 0, demandScore: 22.5 })).toEqual({ value: 22.5, source: "demand_score", coldStart: true, input: 22.5 });
    // A provider's volume of 0 is a measurement too, not a cold start (null is "nobody measured it").
    expect(ev0Demand({ searchVolume: 0, queryImpressions: 0, demandScore: 40 })).toEqual({ value: 0, source: "search_volume", coldStart: false, input: 0 });
    expect(ev0Demand({ searchVolume: null, demandScore: 40 })).toMatchObject({ source: "demand_score", coldStart: true });
    expect(ev0Demand({ demandScore: 400 }).value).toBe(100);
    expect(ev0Demand({})).toEqual({ value: 50, source: "default", coldStart: true, input: null });
  });

  it("reads intent from the provider, else from the wording, comparison first", () => {
    expect(resolveIntent("okta vs entra", "transactional")).toEqual({ value: "transactional", source: "provider" });
    expect(resolveIntent("okta vs entra pricing")).toEqual({ value: "comparison", source: "text" });
    expect(resolveIntent("Best SCIM alternatives to Okta")).toEqual({ value: "comparison", source: "text" });
    expect(resolveIntent("book a scim demo")).toEqual({ value: "transactional", source: "text" });
    expect(resolveIntent("best scim tools")).toEqual({ value: "commercial", source: "text" });
    expect(resolveIntent("okta admin login")).toEqual({ value: "navigational", source: "text" });
    expect(resolveIntent("what is scim provisioning")).toEqual({ value: "informational", source: "default" });
    // Not one of the provider's intents: ignored.
    expect(resolveIntent("what is scim", "comparison")).toEqual({ value: "informational", source: "default" });
  });
});

describe("topical fit", () => {
  const topics = new Map([topic("t-scim", 4, "active", { name: "SCIM provisioning", seed_terms: ["scim"] }), topic("t-old", 2, "archived", { name: "Legacy LDAP", seed_terms: ["ldap"] })]);
  const ctx = topicalContextFrom(topics, { keywords: ["user provisioning"], entities: [{ name: "Acme", aliases: ["Acme ID"] }, { name: "Okta", aliases: [] }] });

  it("is 1 on an active topic, 0.6 when the wording names a seed term, keyword or entity, 0.3 otherwise", () => {
    expect(topicalFit("anything at all", "t-scim", ctx)).toMatchObject({ value: TOPICAL_FIT.topic });
    expect(topicalFit("does scim need sso", null, ctx)).toMatchObject({ value: 0.6, term: "scim" });
    expect(topicalFit("okta alternative for startups", null, ctx)).toMatchObject({ value: 0.6, term: "Okta", reason: 'names the entity "Okta"' });
    expect(topicalFit("how does user provisioning work", null, ctx)).toMatchObject({ value: 0.6, term: "user provisioning" });
    expect(topicalFit("best pizza in boston", null, ctx)).toMatchObject({ value: TOPICAL_FIT.none });
    // Whole words only, and an archived topic's terms no longer count.
    expect(topicalFit("scimitar sword history", null, ctx).value).toBe(0.3);
    expect(topicalFit("migrate from ldap", null, ctx).value).toBe(0.3);
  });

  it("loads the site's keywords, profile keywords and brand entities", async () => {
    const sql = fakeSql([
      [/from app\.sites/, () => [{ org_id: ORG_ID, keywords: ["identity governance"], profile_keywords: ["access reviews", 7] }]],
      [/from context\.entities/, () => [{ id: "e1", org_id: ORG_ID, type: "product", name: "Acme Directory", aliases: [], wikidata_id: null, description: null }]],
    ]);
    const loaded = await loadTopicalContext(SITE_ID, sql, new Map());
    expect(loaded.terms.map((t) => t.raw)).toEqual(expect.arrayContaining(["identity governance", "access reviews", "Acme Directory"]));
    const entities = sql.queries.find((q) => q.text.includes("from context.entities"))!;
    expect(entities.values).toContainEqual({ __array: ["brand", "product", "feature", "integration", "category", "competitor"] });
  });
});

describe("opportunitiesFromCitationGaps", () => {
  it("maps a gap into a new-page citation_gap opportunity keyed by question", () => {
    const [o] = opportunitiesFromCitationGaps([gap({ text: "sso vs scim", competitor_domains: ["okta.com", "microsoft.com"], named_competitor_domains: ["okta.com", "microsoft.com"], named_competitors: 2, snapshot_id: "s1" })]);
    expect(o).toMatchObject({ source: "citation_gap", title: "sso vs scim", targetQuery: "sso vs scim", questionId: Q1, actionType: "new_page", dedupeKey: `question:${Q1}` });
    expect(o!.dedupeKey).toBe(opportunityKey({ id: Q1 }));
    expect(o!.evidence).toMatchObject({ snapshotId: "s1", provider: "serpapi", competitorDomains: ["okta.com", "microsoft.com"], namedCompetitorDomains: ["okta.com", "microsoft.com"], namedCompetitors: 2 });
    expect(o!.scoreBreakdown).toMatchObject({ formula: "ev0", version: EV0_VERSION });
    expect(o!.score).toBe((o!.scoreBreakdown as unknown as EV0Breakdown).ev);
  });

  it("gives a gap a named competitor holds the higher prior; forums, review sites and publishers the lower", () => {
    const [rivals, crowd] = opportunitiesFromCitationGaps([
      gap({ question_id: "rivals", competitor_domains: ["okta.com", "reddit.com"], named_competitor_domains: ["okta.com"], named_competitors: 1 }),
      gap({ question_id: "crowd", competitor_domains: ["g2.com", "reddit.com"], named_competitor_domains: [], named_competitors: 0 }),
    ]);
    expect(parts(rivals!).gap).toEqual({ type: "aio_named_competitor", prior: 0.6 });
    expect(parts(crowd!).gap).toEqual({ type: "aio_other_sources", prior: 0.45 });
    expect(rivals!.score).toBeGreaterThan(crowd!.score);
  });

  it("scores on the question's measured demand and intent when there are some", () => {
    const demand = new Map<string, QuestionDemand>([[Q1, { id: Q1, text: "okta pricing", topic_id: null, demand_score: 12, search_volume: 2400, search_intent: "commercial", query_impressions: 40 }]]);
    const [measured] = opportunitiesFromCitationGaps([gap({ text: "okta pricing" })], new Map(), { demand });
    expect(parts(measured!).demand).toMatchObject({ source: "search_volume", input: 2400, coldStart: false });
    expect(parts(measured!).intent).toEqual({ value: "commercial", source: "provider", weight: 1.5 });
    const [cold] = opportunitiesFromCitationGaps([gap({ text: "okta pricing", demand_score: 12 })]);
    expect(parts(cold!).demand).toMatchObject({ source: "demand_score", value: 12, coldStart: true });
  });

  it("orders the queue on expected value: topic priority, then fit with the site", () => {
    const topics = new Map([topic("p5", 5, "active", { name: "SCIM", seed_terms: ["scim"] }), topic("p1", 1, "active", { name: "Audit logs", seed_terms: ["audit log"] })]);
    const rows = opportunitiesFromCitationGaps(
      [
        gap({ question_id: "on-p5", topic_id: "p5", text: "scim vs saml" }),
        gap({ question_id: "on-p1", topic_id: "p1", text: "what is an audit log" }),
        gap({ question_id: "seed-only", text: "does scim need sso" }),
        gap({ question_id: "off-topic", text: "best pizza in boston" }),
      ],
      topics,
    );
    const score = (id: string) => rows.find((r) => r.questionId === id)!.score;
    expect(score("on-p5")).toBeGreaterThan(score("on-p1"));
    // On no topic but naming a seed: the median topic's value at 0.6 fit. Naming nothing: 0.3.
    expect(parts(rows.find((r) => r.questionId === "seed-only")!).brandFit.value).toBe(0.6);
    expect(parts(rows.find((r) => r.questionId === "off-topic")!).brandFit.value).toBe(0.3);
    expect(score("seed-only")).toBeGreaterThan(score("off-topic"));
  });
});

describe("business value of a question on no topic", () => {
  it("is at most the median active topic, capped at 60, and neutral with no topics", () => {
    expect(defaultBusinessValue(new Map())).toBe(NEUTRAL_BUSINESS_VALUE);
    expect(defaultBusinessValue(new Map([topic("a", 1), topic("b", 2)]))).toBe(20);
    expect(defaultBusinessValue(new Map([topic("a", 2), topic("b", 2), topic("c", 5)]))).toBe(40);
    expect(defaultBusinessValue(new Map([topic("a", 5), topic("b", 4), topic("c", 5)]))).toBe(60);
    // A paused topic is not one the queue serves.
    expect(defaultBusinessValue(new Map([topic("a", 1), topic("b", 5, "paused")]))).toBe(20);
    expect(topiclessValue(new Map([topic("a", 5), topic("b", 4), topic("c", 5)]))).toBe(0.6);
  });

  it("a topicless question does not outrank an equal one on a priority-1 or priority-2 topic, even naming a seed", () => {
    const weights = new Map([topic("p1", 1, "active", { seed_terms: ["scim"] }), topic("p2", 2)]);
    const rows = opportunitiesFromCitationGaps([gap({ question_id: "none" }), gap({ question_id: "one", topic_id: "p1" }), gap({ question_id: "two", topic_id: "p2" })], weights);
    const score = (id: string) => rows.find((r) => r.questionId === id)!.score;
    expect(score("none")).toBeLessThanOrEqual(score("one"));
    expect(score("none")).toBeLessThan(score("two"));
    expect(parts(rows.find((r) => r.questionId === "none")!).businessValue).toEqual({ value: 0.2, source: "topicless" });
  });
});

describe("a person's request", () => {
  it("outranks a scanned gap of the same demand: the highest prior and full fit", async () => {
    const [scanned] = opportunitiesFromCitationGaps([gap({ named_competitors: 1, named_competitor_domains: ["okta.com"], text: "scim vs saml" })], new Map(), { fit: topicalContextFrom(new Map(), { keywords: ["scim"] }) });
    const sql = fakeSql([
      [/from measure\.questions q/, () => [{ id: Q1, text: "scim vs saml", topic_id: null, demand_score: 40, search_volume: null, search_intent: null, query_impressions: null }]],
      [/insert into content\.opportunities/, () => [{ id: "o1" }]],
    ]);
    await createManualOpportunity(SITE_ID, { title: "SCIM vs SAML", questionId: Q1 }, sql);
    const ins = sql.queries.find((q) => q.text.startsWith("insert into content.opportunities"))!;
    const score = ins.values[6] as number;
    const breakdown = (ins.values[7] as { __json: EV0Breakdown }).__json;
    expect(breakdown.components.gap).toEqual({ type: "manual", prior: 1 });
    expect(breakdown.components.brandFit).toEqual({ value: 1, reason: "asked for by a person" });
    expect(breakdown.components.demand).toMatchObject({ source: "demand_score", value: 40 });
    expect(score).toBeGreaterThan(scanned!.score);
    expect(ins.values[9]).toBe(`question:${Q1}`);
    // Reopened after the guard turned it away, it is a page again; a refresh it became stays one.
    expect(ins.text).toContain("action_type = case when content.opportunities.action_type = 'setup_task' then 'new_page' else content.opportunities.action_type end");
    expect(ins.text).toContain("score = case when content.opportunities.score_breakdown->>'formula' is distinct from 'ev0' then excluded.score else greatest(content.opportunities.score, excluded.score) end");
    expect(ins.text).toContain("score_breakdown = case when content.opportunities.score_breakdown->>'formula' is distinct from 'ev0' or excluded.score >= content.opportunities.score then excluded.score_breakdown");
  });

  it("without a question: cold-start demand, the request's own topic, and no question lookup", async () => {
    const sql = fakeSql([
      [/from measure\.topics/, () => [{ id: "t1", priority: 5, formats: ["guide"], status: "active", name: "SCIM", seed_terms: [] }]],
      [/insert into content\.opportunities/, () => [{ id: "o2" }]],
    ]);
    await createManualOpportunity(SITE_ID, { title: "Our SCIM launch", topicId: "t1" }, sql);
    expect(sql.queries.some((q) => q.text.includes("from measure.questions"))).toBe(false);
    const ins = sql.queries.find((q) => q.text.startsWith("insert into content.opportunities"))!;
    const b = (ins.values[7] as { __json: EV0Breakdown }).__json;
    expect(b.components.demand).toMatchObject({ source: "default", value: 50, coldStart: true });
    expect(b.components.businessValue).toEqual({ value: 1, source: "topic", priority: 5 });
    expect(ins.values[4]).toBe("t1");
    expect(ins.values[9]).toBe("manual:our-scim-launch");
  });

  it("isManualOpportunity: made by hand, or merged with a hand-made request", () => {
    expect(isManualOpportunity({ source: "manual", evidence: {} })).toBe(true);
    expect(isManualOpportunity({ source: "citation_gap", evidence: { manual: true } })).toBe(true);
    expect(isManualOpportunity({ source: "citation_gap", evidence: {} })).toBe(false);
  });
});

describe("loadQuestionDemand", () => {
  it("reads volume, intent and the site's Search Console impressions on the query, and asks nothing for no ids", async () => {
    const none = fakeSql();
    expect((await loadQuestionDemand(SITE_ID, [], none)).size).toBe(0);
    expect(none.queries).toHaveLength(0);
    const sql = fakeSql([[/from measure\.questions q/, () => [{ id: Q1, text: "x", topic_id: null, demand_score: 9, search_volume: 70, search_intent: "informational", query_impressions: 12 }]]]);
    const m = await loadQuestionDemand(SITE_ID, [Q1, Q1], sql);
    expect(m.get(Q1)?.search_volume).toBe(70);
    const q = sql.queries[0]!;
    expect(q.text).toContain("m.surface = 'gsc_query' and m.date >= current_date - 28");
    expect(q.text).toContain("lower(btrim(m.dimension->>'query')) in (q.normalized, lower(btrim(q.text)))");
    expect(q.values).toEqual([SITE_ID, { __array: [Q1] }]);
  });
});

describe("upsertOpportunities", () => {
  it("keeps every producer's evidence under bySource; another producer can only raise an EV0 score and never changes the action", async () => {
    const sql = fakeSql([[/insert into content\.opportunities/, () => [{ inserted: false }]]]);
    await upsertOpportunities(SITE_ID, opportunitiesFromCitationGaps([gap()]), sql);
    const text = sql.queries[0]!.text;
    expect(text).toContain("evidence = (content.opportunities.evidence - 'bySource') || excluded.evidence || jsonb_build_object('bySource',");
    expect(text).toContain("coalesce(content.opportunities.evidence->'bySource', jsonb_build_object(content.opportunities.source::text, content.opportunities.evidence))");
    expect(text).toContain("|| jsonb_build_object(excluded.source::text, excluded.evidence)");
    // A score from before EV0 is replaced whoever writes: it is on another scale. The row's own
    // producer replaces its score, except on a person's request merged into the row (the manual prior stays).
    const replaces = "(content.opportunities.score_breakdown->>'formula' is distinct from 'ev0' or (content.opportunities.source = excluded.source and (content.opportunities.evidence->>'manual' is distinct from 'true' or excluded.evidence->>'manual' = 'true')))";
    expect(text).toContain(`score = case when ${replaces} then excluded.score else greatest(content.opportunities.score, excluded.score) end`);
    expect(text).toContain(`score_breakdown = case when ${replaces} or excluded.score > content.opportunities.score then excluded.score_breakdown`);
    // The row's own producer sets the action, but never makes work aimed at an existing page a new page again.
    expect(text).toContain("action_type = case when content.opportunities.source <> excluded.source then content.opportunities.action_type");
    expect(text).toContain("when excluded.action_type = 'new_page' and (content.opportunities.content_item_id is not null or content.opportunities.evidence->>'cmsItemId' is not null) then content.opportunities.action_type else excluded.action_type end");
    expect(sql.queries[0]!.values[13]).toBe("new_page");
    // The hand-made path merges the same way rather than replacing what the scans found.
    const manual = fakeSql([[/insert into content\.opportunities/, () => [{ id: "o1" }]]]);
    await createManualOpportunity(SITE_ID, { title: "SSO vs SCIM", questionId: Q1 }, manual);
    expect(manual.queries.find((q) => q.text.startsWith("insert into content.opportunities"))!.text).toContain("jsonb_build_object('bySource',");
  });

  it("counts inserts vs rescored rows and skips rows the conflict clause refused", async () => {
    let call = 0;
    const sql = fakeSql([[/insert into content\.opportunities/, () => (++call === 1 ? [{ inserted: true }] : call === 2 ? [{ inserted: false }] : [])]]);
    const rows = opportunitiesFromCitationGaps([gap(), gap({ question_id: "q2" }), gap({ question_id: "q3" })]);
    expect(await upsertOpportunities(SITE_ID, rows, sql)).toEqual({ inserted: 1, updated: 1 });
    expect(sql.queries).toHaveLength(3);
    expect(sql.queries[0]!.text).toContain("where content.opportunities.status = 'open'");
    expect(sql.queries[0]!.values[0]).toBe(SITE_ID);
    expect(sql.queries[0]!.values[12]).toBe(`question:${Q1}`);
  });

  it("scanSite runs the gap query, reads demand and fit, brings old-formula rows onto EV0, then upserts", async () => {
    const sql = fakeSql([
      [/from measure\.v_native_aio/, () => [gap()]],
      [/from measure\.questions q/, () => [{ id: Q1, text: "what is scim provisioning", topic_id: null, demand_score: 40, search_volume: 500, search_intent: null, query_impressions: null }]],
      [/insert into content\.opportunities/, () => [{ inserted: true }]],
    ]);
    expect(await scanSite(SITE_ID, sql)).toEqual({ inserted: 1, updated: 0, gaps: 1, rescored: 0 });
    const ins = sql.queries.find((q) => q.text.startsWith("insert into content.opportunities"))!;
    expect((ins.values[10] as { __json: EV0Breakdown }).__json.components.demand).toMatchObject({ source: "search_volume", input: 500 });
    // The old-formula pass runs before the gaps merge in, so a merge compares two EV0 scores.
    const legacy = sql.queries.findIndex((q) => q.text.includes("score_breakdown->>'formula' is distinct from 'ev0' order by created_at"));
    expect(legacy).toBeGreaterThanOrEqual(0);
    expect(legacy).toBeLessThan(sql.queries.indexOf(ins));
  });
});

describe("rows scored before EV0", () => {
  const stored = (over: Partial<StoredOpportunity> = {}): StoredOpportunity => ({
    id: "o1", source: "citation_gap", action_type: "new_page", title: "what is scim provisioning", target_query: "what is scim provisioning", question_id: Q1, topic_id: null, evidence: {}, ...over,
  });
  const q1: QuestionDemand = { id: Q1, text: "what is scim provisioning", topic_id: "t1", demand_score: 30, search_volume: 5000, search_intent: null, query_impressions: null };
  const ctx = { demand: new Map([[Q1, q1]]), topics: new Map([topic("t1", 5, "active", { name: "SCIM", seed_terms: ["scim"] })]), topicless: 0.5, fit: topicalContextFrom(new Map([topic("t1", 5, "active", { name: "SCIM", seed_terms: ["scim"] })])) };
  const signals = (over: Record<string, unknown> = {}) => ({
    ageDays: 400, wordCount: 900, headingCount: 5,
    gsc: { available: true, clicks: 40, clicksPrev: 100, impressions: 900, impressionsPrev: 1000, position: 7 },
    citations: { native: 0, nativePrev: 0, profound: 0, profoundPrev: 0, nativeAvailable: true, profoundAvailable: false },
    ...over,
  });

  it("scores each row on its own producer's inputs", () => {
    const gapIn = storedEV0Input(stored({ evidence: { namedCompetitors: 1 } }), ctx);
    expect(gapIn).toMatchObject({ gapType: "aio_named_competitor", actionType: "new_page", topic: { id: "t1" }, brandFit: { value: 1 }, demand: { searchVolume: 5000 } });
    expect(storedEV0Input(stored(), ctx).gapType).toBe("aio_other_sources");
    expect(storedEV0Input(stored({ source: "signal", evidence: { demandScore: 70 } }), { ...ctx, demand: new Map() })).toMatchObject({ gapType: "unanswered_signal", demand: { demandScore: 70 } });
    // A person's request, or a row one merged into, keeps the manual prior and full fit.
    expect(storedEV0Input(stored({ source: "manual", question_id: null, evidence: { manual: true } }), ctx)).toMatchObject({ gapType: "manual", brandFit: { value: 1, reason: "asked for by a person" } });
    expect(storedEV0Input(stored({ evidence: { manual: true } }), ctx).gapType).toBe("manual");
    // The refresh scan's row: the page's own impressions and the gap its stored signals show, on its own page.
    const cms = storedEV0Input(stored({ source: "refresh", action_type: "refresh", question_id: null, target_query: "The SCIM guide", evidence: { kind: "cms_refresh", signals: signals() } }), ctx);
    expect(cms).toMatchObject({ gapType: "refresh_decline", actionType: "refresh", demand: { pageImpressions: 900 }, brandFit: { value: 1, reason: "the site's own page" }, topic: { id: "t1" } });
    // The post-publish loop's row: the gap its article was written for.
    expect(storedEV0Input(stored({ source: "refresh", action_type: "refresh", evidence: { snapshotId: "s" } }), ctx)).toMatchObject({ gapType: "aio_other_sources", brandFit: { value: 1 }, actionType: "refresh" });
  });

  it("re-scores the open, queued and running rows still on the old formula in one statement, and leaves the rest", async () => {
    const sql = fakeSql([
      [/from content\.opportunities\s+where site_id/, () => [stored({ id: "o-signal", source: "signal", evidence: { demandScore: 30 } }), stored({ id: "o-manual", source: "manual", question_id: null, title: "old manual request", target_query: "old manual request", evidence: { manual: true } })]],
      [/from measure\.questions q/, () => [q1]],
      [/from measure\.topics/, () => [{ id: "t1", priority: 5, formats: [], status: "active", name: "SCIM", seed_terms: ["scim"] }]],
      [/update content\.opportunities o set score/, () => [{ id: "o-signal" }, { id: "o-manual" }]],
    ]);
    expect(await rescoreLegacyOpportunities(SITE_ID, sql)).toEqual({ rescored: 2 });
    const select = sql.queries[0]!;
    expect(select.text).toContain("status in ('open', 'queued', 'in_progress') and score_breakdown->>'formula' is distinct from 'ev0'");
    const update = sql.queries.find((q) => q.text.startsWith("update content.opportunities o set score"))!;
    expect(update.text).toContain("from jsonb_to_recordset($1) as v(id uuid, score numeric, breakdown jsonb)");
    // A row a producer re-scored in the meantime keeps that score.
    expect(update.text).toContain("where o.id = v.id and o.site_id = $2 and o.score_breakdown->>'formula' is distinct from 'ev0'");
    const rows = (update.values[0] as { __json: { id: string; score: number; breakdown: EV0Breakdown }[] }).__json;
    expect(rows.map((r) => [r.id, r.breakdown.formula, r.breakdown.components.gap.type])).toEqual([["o-signal", "ev0", "unanswered_signal"], ["o-manual", "ev0", "manual"]]);
    expect(rows.every((r) => r.score === r.breakdown.ev)).toBe(true);

    const none = fakeSql();
    expect(await rescoreLegacyOpportunities(SITE_ID, none)).toEqual({ rescored: 0 });
    expect(none.queries).toHaveLength(1);
  });
});

describe("refresh + status", () => {
  it("openRefreshOpportunity is idempotent per (item, window), links the content item and scores the window's gap", async () => {
    const sql = fakeSql([[/insert into content\.opportunities/, () => [{ inserted: true }]]]);
    await openRefreshOpportunity({ siteId: SITE_ID, contentItemId: "item-1", questionId: Q1, title: "SSO vs SCIM", targetQuery: "sso vs scim", windowDays: 30, evidence: { owned: false } }, sql);
    const q = sql.queries.find((x) => x.text.startsWith("insert into content.opportunities"))!;
    expect(q.values[1]).toBe("refresh");
    expect(q.values[2]).toBe("Refresh: SSO vs SCIM");
    expect(q.values[5]).toBe("item-1");
    expect(q.values[12]).toBe("refresh:item-1:30d");
    expect(q.values[13]).toBe("refresh");
    const b = (q.values[10] as { __json: EV0Breakdown }).__json;
    expect(b.components.gap.type).toBe("refresh_lost_citation");
    expect(b.components.effort).toEqual({ action: "refresh", value: 1 });
    expect(b.components.brandFit.value).toBe(1);

    const never = fakeSql([[/insert into content\.opportunities/, () => [{ inserted: true }]]]);
    await openRefreshOpportunity({ siteId: SITE_ID, contentItemId: "item-1", questionId: Q1, gapType: "aio_named_competitor", title: "SSO vs SCIM", targetQuery: "sso vs scim", windowDays: 14, evidence: {} }, never);
    expect((never.queries.find((x) => x.text.startsWith("insert"))!.values[10] as { __json: EV0Breakdown }).__json.components.gap).toEqual({ type: "aio_named_competitor", prior: 0.6 });
  });

  it("markOpportunity keeps an earlier dismissed_reason when none is given; loadOpportunity returns null for a miss", async () => {
    const sql = fakeSql();
    await markOpportunity("o1", "failed", sql, "boom");
    await markOpportunity("o1", "in_progress", sql);
    expect(sql.queries[0]!.values).toEqual(["failed", "boom", "o1"]);
    expect(sql.queries[1]!.values).toEqual(["in_progress", null, "o1"]);
    expect(await loadOpportunity("nope", sql)).toBeNull();
    expect(sql.queries[2]!.text).toContain("action_type");
  });

  it("dismisses with a reason only what is still open or running, and records a refusal on the failed row", async () => {
    const sql = fakeSql([[/update content\.opportunities/, (q) => (q.values[3] === "o1" ? [{ id: "o1" }] : [])]]);
    expect(await dismissOpportunity("o1", "auto_coverage", "acme.com/sso already ranks #3", sql, { actionType: "setup_task" })).toEqual({ applied: true });
    expect(await dismissOpportunity("o2", "low_value", null, sql)).toEqual({ applied: false });
    expect(sql.queries[0]!.text).toContain("where id = $4 and status in ('open', 'queued', 'in_progress')");
    expect(sql.queries[0]!.values).toEqual(["auto_coverage", "acme.com/sso already ranks #3", "setup_task", "o1"]);
    expect(sql.queries[0]!.text).toContain("action_type = coalesce($3::content.action_type, action_type)");
    expect(sql.queries[1]!.values[2]).toBeNull();

    const failed = fakeSql();
    await markFailed("o3", "model refused the brief (cyber) — needs a human", "model_refusal", failed);
    expect(failed.queries[0]!.text).toContain("set status = 'failed', dismissed_reason = $1, dismiss_reason = $2");
    expect(failed.queries[0]!.values).toEqual(["model refused the brief (cyber) — needs a human", "model_refusal", "o3"]);
  });

  it("knows which work starts from the live page", () => {
    expect(refreshesExistingPage({ source: "refresh" })).toBe(true);
    expect(refreshesExistingPage({ source: "citation_gap", action_type: "refresh" })).toBe(true);
    expect(refreshesExistingPage({ source: "citation_gap", action_type: "update_stats" })).toBe(true);
    expect(refreshesExistingPage({ source: "citation_gap", action_type: "new_page" })).toBe(false);
    expect(refreshesExistingPage({ source: "manual" })).toBe(false);
  });
});
