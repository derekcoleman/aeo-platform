import { describe, expect, it } from "vitest";
import type { CitationGap } from "@/lib/demand/store";
import { createManualOpportunity, defaultBusinessValue, loadOpportunity, markOpportunity, NEUTRAL_BUSINESS_VALUE, openRefreshOpportunity, opportunitiesFromCitationGaps, SCORE_WEIGHTS, scanSite, scoreOpportunity, upsertOpportunities, type TopicWeight } from "@/lib/pipeline/opportunities";
import { fakeSql } from "./helpers/fake-sql";
import { SITE_ID } from "./fixtures/pipeline";

const Q1 = "dddddddd-0000-0000-0000-000000000001";

describe("scoreOpportunity", () => {
  it("weights each input and stores the breakdown next to the score", () => {
    const s = scoreOpportunity({ demand: 80, citationGap: 100, brandFit: 60, businessValue: 40, difficulty: 20, freshness: 0 });
    expect(s.breakdown.demand).toEqual({ value: 80, weight: 0.3, contribution: 24 });
    expect(s.breakdown.difficulty).toEqual({ value: 20, weight: -0.15, contribution: -3 });
    const sum = Object.values(s.breakdown).reduce((a, b) => a + b.contribution, 0);
    expect(s.score).toBe(Math.round(sum * 100) / 100);
    expect(Object.keys(s.breakdown)).toEqual(Object.keys(SCORE_WEIGHTS));
  });

  it("clamps to 0–100, defaults unknown inputs to neutral, never goes negative", () => {
    const s = scoreOpportunity({ demand: -50, citationGap: 500 });
    expect(s.breakdown.demand.value).toBe(0);
    expect(s.breakdown.citationGap.value).toBe(100);
    expect(s.breakdown.brandFit.value).toBe(50);
    expect(scoreOpportunity({ demand: 0, citationGap: 0, brandFit: 0, businessValue: 0, difficulty: 100 }).score).toBe(0);
  });
});

describe("opportunitiesFromCitationGaps", () => {
  it("maps a gap into a scored citation_gap opportunity keyed by question", () => {
    const gap: CitationGap = { question_id: Q1, topic_id: null, text: "sso vs scim", demand_score: 70, snapshot_id: "s1", fetched_at: "2026-09-01T00:00:00Z", provider: "serpapi", competitor_domains: ["okta.com", "microsoft.com"], named_competitor_domains: ["okta.com", "microsoft.com"], named_competitors: 2 };
    const [o] = opportunitiesFromCitationGaps([gap]);
    expect(o).toMatchObject({ source: "citation_gap", title: "sso vs scim", targetQuery: "sso vs scim", questionId: Q1, dedupeKey: `question:${Q1}` });
    expect(o!.evidence).toMatchObject({ snapshotId: "s1", provider: "serpapi", competitorDomains: ["okta.com", "microsoft.com"], namedCompetitorDomains: ["okta.com", "microsoft.com"] });
    expect((o!.scoreBreakdown as { citationGap: { value: number } }).citationGap.value).toBe(80);
    expect(o!.score).toBeGreaterThan(40);
  });

  it("sizes the gap by named competitors; forums, review sites and publishers count for little", () => {
    const base = { topic_id: null, text: "sso vs scim", demand_score: 50, snapshot_id: "s", fetched_at: "", provider: "serpapi" };
    const [rivals, crowd, mixed, hosts] = opportunitiesFromCitationGaps([
      { ...base, question_id: "rivals", competitor_domains: ["okta.com", "onelogin.com"], named_competitor_domains: ["okta.com", "onelogin.com"], named_competitors: 2 },
      { ...base, question_id: "crowd", competitor_domains: ["g2.com", "reddit.com"], named_competitor_domains: [], named_competitors: 0 },
      { ...base, question_id: "mixed", competitor_domains: ["okta.com", "reddit.com", "wikipedia.org"], named_competitor_domains: ["okta.com"], named_competitors: 1 },
      { ...base, question_id: "one rival, two hosts", competitor_domains: ["blog.okta.com", "okta.com", "reddit.com"], named_competitor_domains: ["blog.okta.com", "okta.com"], named_competitors: 1 },
    ]);
    const parts = (o: typeof rivals) => o!.scoreBreakdown as { citationGap: { value: number }; difficulty: { value: number } };
    // 60 + 10 per named competitor + 3 per other cited site; difficulty 30 + 8 per named competitor.
    expect(parts(rivals).citationGap.value).toBe(80);
    expect(parts(rivals).difficulty.value).toBe(46);
    expect(parts(crowd).citationGap.value).toBe(66);
    expect(parts(crowd).difficulty.value).toBe(30);
    expect(parts(mixed).citationGap.value).toBe(76);
    expect(parts(mixed).difficulty.value).toBe(38);
    // A rival cited on two of its own hosts is one competitor; its second host is not another site either.
    expect(parts(hosts).citationGap.value).toBe(73);
    expect(parts(hosts).difficulty.value).toBe(38);
    expect(hosts!.evidence).toMatchObject({ namedCompetitorDomains: ["blog.okta.com", "okta.com"], namedCompetitors: 1 });
    expect(crowd!.evidence).toMatchObject({ competitorDomains: ["g2.com", "reddit.com"], namedCompetitorDomains: [] });
    expect(parts(rivals).citationGap.value).toBeGreaterThan(parts(crowd).citationGap.value);
  });
});

describe("business value of a question on no topic", () => {
  const topic = (id: string, priority: number, status: TopicWeight["status"] = "active"): [string, TopicWeight] => [id, { id, priority, formats: [], status }];
  const gap = (id: string, topicId: string | null): CitationGap => ({ question_id: id, topic_id: topicId, text: id, demand_score: 40, snapshot_id: "s", fetched_at: "", provider: "serpapi", competitor_domains: ["okta.com"], named_competitor_domains: [], named_competitors: 0 });

  it("is at most the median active topic, capped at 60, and neutral with no topics", () => {
    expect(defaultBusinessValue(new Map())).toBe(NEUTRAL_BUSINESS_VALUE);
    expect(defaultBusinessValue(new Map([topic("a", 1), topic("b", 2)]))).toBe(20);
    expect(defaultBusinessValue(new Map([topic("a", 2), topic("b", 2), topic("c", 5)]))).toBe(40);
    expect(defaultBusinessValue(new Map([topic("a", 5), topic("b", 4), topic("c", 5)]))).toBe(60);
    // A paused topic is not one the queue serves.
    expect(defaultBusinessValue(new Map([topic("a", 1), topic("b", 5, "paused")]))).toBe(20);
  });

  it("a topicless question does not outrank an equal one on a priority-1 or priority-2 topic", () => {
    const weights = new Map([topic("p1", 1), topic("p2", 2)]);
    const rows = opportunitiesFromCitationGaps([gap("none", null), gap("one", "p1"), gap("two", "p2")], weights);
    const score = (id: string) => rows.find((r) => r.questionId === id)!.score;
    expect(score("none")).toBeLessThanOrEqual(score("one"));
    expect(score("none")).toBeLessThan(score("two"));
    expect((rows.find((r) => r.questionId === "none")!.scoreBreakdown as { businessValue: { value: number } }).businessValue.value).toBe(20);
  });
});

describe("upsertOpportunities", () => {
  it("keeps every producer's evidence under bySource and lets another producer only raise the score", async () => {
    const sql = fakeSql([[/insert into content\.opportunities/, () => [{ inserted: false }]]]);
    await upsertOpportunities(SITE_ID, opportunitiesFromCitationGaps([{ question_id: Q1, topic_id: null, text: "a", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "serpapi", competitor_domains: [], named_competitor_domains: [], named_competitors: 0 }]), sql);
    const text = sql.queries[0]!.text;
    expect(text).toContain("evidence = (content.opportunities.evidence - 'bySource') || excluded.evidence || jsonb_build_object('bySource',");
    expect(text).toContain("coalesce(content.opportunities.evidence->'bySource', jsonb_build_object(content.opportunities.source::text, content.opportunities.evidence))");
    expect(text).toContain("|| jsonb_build_object(excluded.source::text, excluded.evidence)");
    expect(text).toContain("score = case when content.opportunities.source = excluded.source then excluded.score else greatest(content.opportunities.score, excluded.score) end");
    // The hand-made path merges the same way rather than replacing what the scans found.
    const manual = fakeSql([[/insert into content\.opportunities/, () => [{ id: "o1" }]]]);
    await createManualOpportunity(SITE_ID, { title: "SSO vs SCIM", questionId: Q1 }, manual);
    expect(manual.queries[0]!.text).toContain("jsonb_build_object('bySource',");
  });

  it("counts inserts vs rescored rows and skips rows the conflict clause refused", async () => {
    let call = 0;
    const sql = fakeSql([[/insert into content\.opportunities/, () => (++call === 1 ? [{ inserted: true }] : call === 2 ? [{ inserted: false }] : [])]]);
    const rows = opportunitiesFromCitationGaps([
      { question_id: Q1, topic_id: null, text: "a", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [], named_competitor_domains: [], named_competitors: 0 },
      { question_id: "q2", topic_id: null, text: "b", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [], named_competitor_domains: [], named_competitors: 0 },
      { question_id: "q3", topic_id: null, text: "c", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [], named_competitor_domains: [], named_competitors: 0 },
    ]);
    expect(await upsertOpportunities(SITE_ID, rows, sql)).toEqual({ inserted: 1, updated: 1 });
    expect(sql.queries).toHaveLength(3);
    expect(sql.queries[0]!.text).toContain("where content.opportunities.status = 'open'");
    expect(sql.queries[0]!.values[0]).toBe(SITE_ID);
    expect(sql.queries[0]!.values[12]).toBe(`question:${Q1}`);
  });

  it("scanSite runs the gap query then upserts", async () => {
    const sql = fakeSql([
      [/from measure\.serp_snapshots/, () => [{ question_id: Q1, topic_id: null, text: "a", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [], named_competitor_domains: [], named_competitors: 0 }]],
      [/insert into content\.opportunities/, () => [{ inserted: true }]],
    ]);
    expect(await scanSite(SITE_ID, sql)).toEqual({ inserted: 1, updated: 0, gaps: 1 });
  });
});

describe("refresh + status", () => {
  it("openRefreshOpportunity is idempotent per (item, window) and links the content item", async () => {
    const sql = fakeSql([[/insert into content\.opportunities/, () => [{ inserted: true }]]]);
    await openRefreshOpportunity({ siteId: SITE_ID, contentItemId: "item-1", questionId: Q1, title: "SSO vs SCIM", targetQuery: "sso vs scim", windowDays: 30, evidence: { owned: false } }, sql);
    const q = sql.queries[0]!;
    expect(q.values[1]).toBe("refresh");
    expect(q.values[2]).toBe("Refresh: SSO vs SCIM");
    expect(q.values[5]).toBe("item-1");
    expect(q.values[12]).toBe("refresh:item-1:30d");
  });

  it("markOpportunity keeps an earlier dismissed_reason when none is given; loadOpportunity returns null for a miss", async () => {
    const sql = fakeSql();
    await markOpportunity("o1", "failed", sql, "boom");
    await markOpportunity("o1", "in_progress", sql);
    expect(sql.queries[0]!.values).toEqual(["failed", "boom", "o1"]);
    expect(sql.queries[1]!.values).toEqual(["in_progress", null, "o1"]);
    expect(await loadOpportunity("nope", sql)).toBeNull();
  });
});
