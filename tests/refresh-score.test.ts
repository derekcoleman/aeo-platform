import { describe, expect, it } from "vitest";
import { candidateExclusion, demandFromImpressions, REFRESH_MIN_AGE_DAYS, REFRESH_THRESHOLD, REFRESH_WEIGHTS, scoreRefresh, type RefreshSignals } from "@/lib/refresh/score";
import { ageDays, refreshDedupeKey, refreshOpportunityFor, scoreInventory, signalsFor, type InventorySignalRow } from "@/lib/refresh/scan";

const NOW = new Date("2026-09-15T12:00:00Z");

function signals(over: Partial<Omit<RefreshSignals, "gsc" | "citations">> & { gsc?: Partial<RefreshSignals["gsc"]>; citations?: Partial<RefreshSignals["citations"]> } = {}): RefreshSignals {
  const { gsc, citations, ...rest } = over;
  return {
    ageDays: 400,
    wordCount: 1200,
    headingCount: 6,
    ...rest,
    gsc: { available: true, clicks: 50, clicksPrev: 50, impressions: 2000, impressionsPrev: 2000, position: 8, ...gsc },
    citations: { native: 0, nativePrev: 0, profound: 0, profoundPrev: 0, nativeAvailable: true, profoundAvailable: false, ...citations },
  };
}

describe("scoreRefresh", () => {
  it("weights sum to one and every factor lands in the breakdown", () => {
    expect(Object.values(REFRESH_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const r = scoreRefresh(signals());
    expect(Object.keys(r.breakdown).sort()).toEqual(Object.keys(REFRESH_WEIGHTS).sort());
    expect(r.score).toBeCloseTo(Object.values(r.breakdown).reduce((a, b) => a + b.contribution, 0), 1);
  });

  it("ranks a stale, trafficked, uncited post above a fresh cited one", () => {
    const stale = scoreRefresh(signals());
    const fresh = scoreRefresh(signals({ ageDays: 20, citations: { native: 4, nativePrev: 3 } }));
    expect(stale.score).toBeGreaterThan(REFRESH_THRESHOLD);
    expect(fresh.score).toBeLessThan(REFRESH_THRESHOLD);
    expect(stale.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/Not updated in 13 months/), "2.0k impressions / 28d", "Search demand but no AI citations"]));
    expect(fresh.reasons).toEqual(["2.0k impressions / 28d"]);
    expect(fresh.breakdown.citationGap.value).toBe(0);
  });

  it("names a click decline and lost citations", () => {
    const declining = scoreRefresh(signals({ ageDays: 200, gsc: { clicks: 20, clicksPrev: 60 }, citations: { native: 0, nativePrev: 3 } }));
    expect(declining.reasons).toContain("Clicks down 67% vs previous 28d");
    expect(declining.reasons).toContain("Lost all 3 AI citations it had");
    expect(declining.breakdown.decline.value).toBe(100);
    expect(declining.breakdown.citationGap.value).toBe(90);
    const fewer = scoreRefresh(signals({ citations: { native: 1, nativePrev: 3 } }));
    expect(fewer.reasons).toContain("AI citations down 3 → 1");
    const impr = scoreRefresh(signals({ gsc: { clicks: 5, clicksPrev: 5, impressions: 700, impressionsPrev: 1000 } }));
    expect(impr.reasons).toContain("Impressions down 30% vs previous 28d");
  });

  it("treats missing signals as neutral, not as zero", () => {
    const blind = scoreRefresh(signals({ gsc: { available: false, clicks: 0, impressions: 0, clicksPrev: 0, impressionsPrev: 0 }, citations: { nativeAvailable: false, profoundAvailable: false } }));
    expect(blind.breakdown.demand.value).toBe(50);
    expect(blind.breakdown.citationGap.value).toBe(50);
    expect(blind.breakdown.decline.value).toBe(0);
    expect(blind.reasons).toEqual([expect.stringMatching(/Not updated/)]);
  });

  it("counts Profound citations when native tracking has none", () => {
    const viaProfound = scoreRefresh(signals({ citations: { nativeAvailable: false, profoundAvailable: true, profound: 2, profoundPrev: 2 } }));
    expect(viaProfound.breakdown.citationGap.value).toBe(0);
    expect(viaProfound.reasons).not.toContain("Search demand but no AI citations");
  });

  it("flags thin bodies and unknown ages", () => {
    const thin = scoreRefresh(signals({ wordCount: 250 }));
    expect(thin.reasons).toContain("Only 250 words");
    expect(thin.breakdown.thinness.value).toBe(80);
    expect(scoreRefresh(signals({ ageDays: null })).breakdown.staleness.value).toBe(100);
    expect(scoreRefresh(signals({ ageDays: 0 })).breakdown.staleness.value).toBe(0);
  });

  it("demandFromImpressions is a log scale capped at 100", () => {
    expect(demandFromImpressions(0)).toBe(0);
    expect(demandFromImpressions(99)).toBeCloseTo(50, 0);
    expect(demandFromImpressions(10_000)).toBe(100);
    expect(demandFromImpressions(1e9)).toBe(100);
  });
});

describe("candidateExclusion", () => {
  const base = { isDraft: false, isArchived: false, missing: false, hasBody: true, ageDays: 400, inFlight: false };
  it("keeps drafts, archived, deleted, bodiless, young and in-flight items out of the queue", () => {
    expect(candidateExclusion(base)).toBeNull();
    expect(candidateExclusion({ ...base, isDraft: true })).toBe("draft");
    expect(candidateExclusion({ ...base, isArchived: true })).toBe("archived");
    expect(candidateExclusion({ ...base, missing: true })).toBe("deleted in the CMS");
    expect(candidateExclusion({ ...base, hasBody: false })).toBe("no rich-text body");
    expect(candidateExclusion({ ...base, ageDays: REFRESH_MIN_AGE_DAYS - 1 })).toMatch(/updated 44d ago/);
    expect(candidateExclusion({ ...base, ageDays: null })).toBeNull();
    expect(candidateExclusion({ ...base, inFlight: true })).toBe("refresh in progress");
  });
});

function row(over: Partial<InventorySignalRow> = {}): InventorySignalRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    site_id: "s1",
    title: "SSO vs SCIM",
    url: "https://acme.com/blog/sso-vs-scim",
    collection_name: "Blog Posts",
    content_item_id: null,
    last_updated: new Date("2025-06-01T00:00:00Z"),
    is_draft: false,
    is_archived: false,
    missing: false,
    has_body: true,
    word_count: 900,
    heading_count: 5,
    in_flight: false,
    clicks: 40,
    clicks_prev: 80,
    impressions: 3000,
    impressions_prev: 3200,
    position: 9.5,
    cited_native: 0,
    cited_native_prev: 2,
    cited_profound: 0,
    cited_profound_prev: 0,
    ...over,
  };
}

describe("scoreInventory", () => {
  const avail = { gsc: true, native: true, profound: false };

  it("maps rows to signals with the age computed from last_updated", () => {
    expect(ageDays(new Date("2026-09-01T00:00:00Z"), NOW)).toBe(14);
    expect(ageDays(null, NOW)).toBeNull();
    const s = signalsFor(row(), avail, NOW);
    expect(s.ageDays).toBe(471);
    expect(s.gsc).toEqual({ available: true, clicks: 40, clicksPrev: 80, impressions: 3000, impressionsPrev: 3200, position: 9.5 });
    expect(s.citations).toMatchObject({ native: 0, nativePrev: 2, nativeAvailable: true, profoundAvailable: false });
  });

  it("returns candidates best first, without the excluded and the low scorers", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "draft", is_draft: true }),
      row({ id: "fresh", last_updated: new Date("2026-09-10T00:00:00Z"), clicks: 80, cited_native: 3, cited_native_prev: 3 }),
      row({ id: "cited-holding", last_updated: new Date("2026-01-01T00:00:00Z"), clicks: 80, cited_native: 3, cited_native_prev: 3 }),
      row({ id: "b", clicks: 5, clicks_prev: 5, impressions: 50, impressions_prev: 50, cited_native_prev: 0, word_count: 300 }),
    ];
    const { items, candidates } = scoreInventory(rows, avail, NOW);
    expect(items).toHaveLength(5);
    expect(items.find((i) => i.row.id === "draft")!.exclusion).toBe("draft");
    expect(items.find((i) => i.row.id === "fresh")!.exclusion).toMatch(/updated 5d ago/);
    expect(candidates.map((c) => c.row.id)[0]).toBe("a");
    expect(candidates.map((c) => c.row.id)).not.toContain("draft");
    expect(candidates.map((c) => c.row.id)).not.toContain("fresh");
    expect(candidates.map((c) => c.row.id)).not.toContain("cited-holding");
    for (let i = 1; i < candidates.length; i++) expect(candidates[i - 1]!.scored.score).toBeGreaterThanOrEqual(candidates[i]!.scored.score);
  });

  it("builds a refresh opportunity whose dedupe key changes when the post changes", () => {
    const { candidates } = scoreInventory([row()], avail, NOW);
    const opp = refreshOpportunityFor(candidates[0]!);
    expect(opp).toMatchObject({ source: "refresh", title: "Refresh: SSO vs SCIM", targetQuery: "SSO vs SCIM", contentItemId: null, dedupeKey: "cms:11111111-1111-4111-8111-111111111111:2025-06-01" });
    expect(opp.evidence).toMatchObject({ kind: "cms_refresh", cmsItemId: "11111111-1111-4111-8111-111111111111", url: "https://acme.com/blog/sso-vs-scim", collection: "Blog Posts" });
    expect((opp.evidence.reasons as string[]).length).toBeGreaterThan(0);
    expect(refreshDedupeKey("x", null)).toBe("cms:x:unknown");
    expect(refreshDedupeKey("x", "2026-01-02T10:00:00Z")).toBe("cms:x:2026-01-02");
  });
});
