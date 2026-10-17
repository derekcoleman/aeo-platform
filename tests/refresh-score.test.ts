import { describe, expect, it } from "vitest";
import { EV0_VERSION, GAP_PRIORS, type EV0Breakdown } from "@/lib/pipeline/opportunities";
import { candidateExclusion, demandFromImpressions, isProtectedWinner, median, REFRESH_MIN_AGE_DAYS, REFRESH_THRESHOLD, REFRESH_WEIGHTS, refreshGapType, scoreRefresh, type RefreshSignals } from "@/lib/refresh/score";
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

describe("protected winners", () => {
  const winner = signals({ gsc: { clicks: 60, clicksPrev: 55, impressions: 2000, impressionsPrev: 1900 }, citations: { native: 3, nativePrev: 3 } });

  it("protects a page cited natively and holding, with clicks at or above the median and no decline", () => {
    expect(isProtectedWinner(winner, 60)).toBe(true);
    expect(isProtectedWinner(winner, 40)).toBe(true);
  });

  it("does not protect a page that lost citations, sits below the median, is declining, or that only Profound cites", () => {
    expect(isProtectedWinner({ ...winner, citations: { ...winner.citations, native: 2 } }, 40)).toBe(false);
    expect(isProtectedWinner(winner, 61)).toBe(false);
    expect(isProtectedWinner({ ...winner, gsc: { ...winner.gsc, clicks: 30, clicksPrev: 60 } }, 10)).toBe(false);
    expect(isProtectedWinner({ ...winner, gsc: { ...winner.gsc, impressions: 1000, impressionsPrev: 2000 } }, 40)).toBe(false);
    expect(isProtectedWinner({ ...winner, citations: { ...winner.citations, native: 0, nativePrev: 0, profound: 5, profoundPrev: 4 } }, 40)).toBe(false);
    // No Search Console: a winner cannot be told from a page nobody visits.
    expect(isProtectedWinner({ ...winner, gsc: { ...winner.gsc, available: false } }, 0)).toBe(false);
  });

  it("names the gap a refresh closes: citations lost, then a decline, then staleness", () => {
    expect(refreshGapType(signals({ citations: { native: 0, nativePrev: 2 } }))).toBe("refresh_lost_citation");
    // Profound's losses count too; a tracker with nothing to say does not.
    expect(refreshGapType(signals({ citations: { nativeAvailable: false, profoundAvailable: true, profound: 1, profoundPrev: 3 } }))).toBe("refresh_lost_citation");
    expect(refreshGapType(signals({ citations: { nativeAvailable: false, native: 0, nativePrev: 2 } }))).toBe("refresh_stale");
    expect(refreshGapType(signals({ gsc: { clicks: 30, clicksPrev: 60 } }))).toBe("refresh_decline");
    expect(refreshGapType(signals({ gsc: { impressions: 700, impressionsPrev: 1000 } }))).toBe("refresh_decline");
    // A drop on a base too small to read is not a decline.
    expect(refreshGapType(signals({ gsc: { clicks: 2, clicksPrev: 8, impressions: 50, impressionsPrev: 90 } }))).toBe("refresh_stale");
    expect(refreshGapType(signals())).toBe("refresh_stale");
  });

  it("median handles odd, even and empty lists", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
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

  it("queues a stale winner for its figures and dates only, judged against the inventory's median clicks", () => {
    const rows = [
      // Old and thin enough to score as a candidate, but cited and holding with traffic.
      row({ id: "winner", word_count: 300, clicks: 90, clicks_prev: 85, impressions: 3000, impressions_prev: 3000, cited_native: 2, cited_native_prev: 2 }),
      row({ id: "loser", clicks: 10, clicks_prev: 40 }),
      row({ id: "quiet", clicks: 5, clicks_prev: 5, impressions: 200, impressions_prev: 200 }),
    ];
    const { items, candidates, medianClicks } = scoreInventory(rows, avail, NOW);
    expect(medianClicks).toBe(10);
    const winner = items.find((i) => i.row.id === "winner")!;
    expect(winner).toMatchObject({ exclusion: null, protectedWinner: true });
    expect(candidates.map((c) => c.row.id)).toEqual(expect.arrayContaining(["winner", "loser"]));
    // Never a rewrite: a statistics update, at half a refresh's effort.
    const stats = refreshOpportunityFor(winner);
    expect(stats.actionType).toBe("update_stats");
    expect(stats.evidence).toMatchObject({ protectedWinner: true });
    expect(stats.evidence.reasons).toContain("Cited and holding with traffic: update figures and dates only");
    expect((stats.scoreBreakdown as unknown as EV0Breakdown).components.effort).toEqual({ action: "update_stats", value: 0.5 });
    expect(refreshOpportunityFor(candidates.find((c) => c.row.id === "loser")!).actionType).toBe("refresh");
    // A person who asks for a refresh of a winner gets one.
    expect(refreshOpportunityFor(winner, { manual: true })).toMatchObject({ actionType: "refresh" });
    expect((refreshOpportunityFor(winner, { manual: true }).scoreBreakdown as unknown as EV0Breakdown).components.gap).toEqual({ type: "manual", prior: 1 });
  });

  it("scores a refresh on expected value: the page's own impressions, the gap it closes, its title's topic", () => {
    const { candidates } = scoreInventory([row({ clicks: 40, clicks_prev: 80, impressions: 3000, impressions_prev: 3200, cited_native: 0, cited_native_prev: 2 })], avail, NOW);
    const topics = new Map([["t-scim", { id: "t-scim", priority: 5, formats: [], status: "active" as const, name: "SCIM", seed_terms: ["scim"] }]]);
    const opp = refreshOpportunityFor(candidates[0]!, { topics });
    const b = opp.scoreBreakdown as unknown as EV0Breakdown;
    expect(b).toMatchObject({ formula: "ev0", version: EV0_VERSION, predictedLift: null });
    expect(b.components.demand).toMatchObject({ source: "gsc_page_impressions", coldStart: false, input: 3000 });
    expect(b.components.gap).toEqual({ type: "refresh_lost_citation", prior: GAP_PRIORS.refresh_lost_citation });
    expect(b.components.businessValue).toEqual({ value: 1, source: "topic", priority: 5 });
    expect(b.components.brandFit.value).toBe(1);
    expect(b.components.intent.value).toBe("comparison");
    expect(opp.score).toBe(b.ev);
    // Search Console connected and nobody sees the page: no demand, not a cold start.
    const unseen = refreshOpportunityFor(scoreInventory([row({ clicks: 0, clicks_prev: 0, impressions: 0, impressions_prev: 0 })], avail, NOW).items[0]!);
    expect((unseen.scoreBreakdown as unknown as EV0Breakdown).components.demand).toMatchObject({ value: 0, coldStart: false });
    // Without Search Console the demand is unknown: neutral, flagged as a cold start.
    const blind = refreshOpportunityFor(scoreInventory([row()], { ...avail, gsc: false }, NOW).items[0]!);
    expect((blind.scoreBreakdown as unknown as EV0Breakdown).components.demand).toMatchObject({ value: 50, source: "default", coldStart: true });
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
