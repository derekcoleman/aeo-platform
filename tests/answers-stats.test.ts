import { describe, expect, it } from "vitest";
import { LOW_N, wilson } from "@/lib/answers/stats";

describe("wilson", () => {
  it("matches the published 95% Wilson score intervals", () => {
    const at = (k: number, n: number) => {
      const w = wilson(k, n);
      return [w.p, w.low, w.high].map((v) => Math.round(v! * 10_000) / 10_000);
    };
    expect(at(5, 10)).toEqual([0.5, 0.2366, 0.7634]);
    expect(at(1, 20)).toEqual([0.05, 0.0089, 0.2361]);
    expect(at(30, 100)).toEqual([0.3, 0.2189, 0.3959]);
  });

  it("stays inside [0, 1] at the edges, where the normal approximation does not", () => {
    expect(wilson(0, 10)).toMatchObject({ p: 0, low: 0 });
    expect(wilson(0, 10).high).toBeCloseTo(0.2775, 4);
    expect(wilson(10, 10)).toMatchObject({ p: 1, high: 1 });
    expect(wilson(10, 10).low).toBeCloseTo(0.7225, 4);
  });

  it("has no share without answers, and clamps a count outside 0..n", () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, p: null, low: null, high: null });
    expect(wilson(12, 10)).toMatchObject({ k: 10, p: 1 });
    expect(wilson(-1, 10)).toMatchObject({ k: 0, p: 0 });
  });

  it("narrows as n grows, and a panel week is low n", () => {
    const width = (n: number) => wilson(n / 2, n).high! - wilson(n / 2, n).low!;
    expect(width(100)).toBeLessThan(width(25));
    expect(LOW_N).toBe(30);
  });
});
