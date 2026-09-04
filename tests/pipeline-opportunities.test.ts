import { describe, expect, it } from "vitest";
import type { CitationGap } from "@/lib/demand/store";
import { loadOpportunity, markOpportunity, openRefreshOpportunity, opportunitiesFromCitationGaps, SCORE_WEIGHTS, scanSite, scoreOpportunity, upsertOpportunities } from "@/lib/pipeline/opportunities";
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
    const gap: CitationGap = { question_id: Q1, topic_id: null, text: "sso vs scim", demand_score: 70, snapshot_id: "s1", fetched_at: "2026-09-01T00:00:00Z", provider: "serpapi", competitor_domains: ["okta.com", "microsoft.com"] };
    const [o] = opportunitiesFromCitationGaps([gap]);
    expect(o).toMatchObject({ source: "citation_gap", title: "sso vs scim", targetQuery: "sso vs scim", questionId: Q1, dedupeKey: `question:${Q1}` });
    expect(o!.evidence).toMatchObject({ snapshotId: "s1", provider: "serpapi", competitorDomains: ["okta.com", "microsoft.com"] });
    expect((o!.scoreBreakdown as { citationGap: { value: number } }).citationGap.value).toBe(80);
    expect(o!.score).toBeGreaterThan(40);
  });
});

describe("upsertOpportunities", () => {
  it("counts inserts vs rescored rows and skips rows the conflict clause refused", async () => {
    let call = 0;
    const sql = fakeSql([[/insert into content\.opportunities/, () => (++call === 1 ? [{ inserted: true }] : call === 2 ? [{ inserted: false }] : [])]]);
    const rows = opportunitiesFromCitationGaps([
      { question_id: Q1, topic_id: null, text: "a", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [] },
      { question_id: "q2", topic_id: null, text: "b", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [] },
      { question_id: "q3", topic_id: null, text: "c", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [] },
    ]);
    expect(await upsertOpportunities(SITE_ID, rows, sql)).toEqual({ inserted: 1, updated: 1 });
    expect(sql.queries).toHaveLength(3);
    expect(sql.queries[0]!.text).toContain("where content.opportunities.status = 'open'");
    expect(sql.queries[0]!.values[0]).toBe(SITE_ID);
    expect(sql.queries[0]!.values[12]).toBe(`question:${Q1}`);
  });

  it("scanSite runs the gap query then upserts", async () => {
    const sql = fakeSql([
      [/from measure\.serp_snapshots/, () => [{ question_id: Q1, topic_id: null, text: "a", demand_score: 10, snapshot_id: "s", fetched_at: "", provider: "p", competitor_domains: [] }]],
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
