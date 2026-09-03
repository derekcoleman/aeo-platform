import { describe, expect, it } from "vitest";
import { DIMENSION_WEIGHTS, calculateGeoScore, collectDimensions, llmsTxtScore } from "@/lib/audit/score";

describe("DIMENSION_WEIGHTS", () => {
  it("sum to 1 and exclude platform readiness", () => {
    const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect("platform" in DIMENSION_WEIGHTS).toBe(false);
  });
});

describe("calculateGeoScore", () => {
  const full = { crawlerAccess: 80, schema: 60, citability: 70, eeat: 50, technical: 90, llmsTxt: 100 };

  it("is the weighted mean when every dimension ran", () => {
    const expected = Math.round(
      80 * 0.2 + 60 * 0.15 + 70 * 0.25 + 50 * 0.15 + 90 * 0.2 + 100 * 0.05,
    );
    expect(calculateGeoScore(full)).toEqual({ score: expected, coverage: 1 });
  });

  it("renormalises over available dimensions instead of counting a degraded module as zero", () => {
    const partial = { ...full, citability: null };
    const { score, coverage } = calculateGeoScore(partial);
    expect(coverage).toBe(0.75);
    const expected = Math.round((80 * 0.2 + 60 * 0.15 + 50 * 0.15 + 90 * 0.2 + 100 * 0.05) / 0.75);
    expect(score).toBe(expected);
    // The old behaviour — zero-fill — would have produced a materially lower number.
    expect(score).toBeGreaterThan(calculateGeoScore({ ...full, citability: 0 }).score);
  });

  it("returns coverage 0 when nothing ran", () => {
    expect(calculateGeoScore({ crawlerAccess: null, schema: null, citability: null, eeat: null, technical: null, llmsTxt: null })).toEqual({ score: 0, coverage: 0 });
  });

  it("clamps out-of-range inputs", () => {
    expect(calculateGeoScore({ ...full, technical: 500 }).score).toBeLessThanOrEqual(100);
  });
});

describe("collectDimensions / llmsTxtScore", () => {
  it("maps null modules to null, not 0", () => {
    const d = collectDimensions({ crawlerAccess: null, schema: null, citability: null, eeat: null, technical: null, llmsTxt: null });
    expect(Object.values(d).every((v) => v === null)).toBe(true);
  });
  it("scores llms.txt by presence, validity and depth", () => {
    expect(llmsTxtScore({ found: false, url: "", valid: false, sections: [], issues: [] })).toBe(0);
    expect(llmsTxtScore({ found: true, url: "", valid: false, sections: [], issues: ["x"] })).toBe(40);
    expect(llmsTxtScore({ found: true, url: "", valid: true, sections: ["a"], issues: [] })).toBe(70);
    expect(llmsTxtScore({ found: true, url: "", valid: true, sections: ["a", "b", "c"], issues: [] })).toBe(100);
  });
});
