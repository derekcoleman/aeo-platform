import { describe, expect, it } from "vitest";
import { concurrencyCap, PLAN_CONCURRENCY } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest";

/**
 * Inngest rejects the whole app sync when one function's concurrency limit
 * exceeds the plan's cap, and then nothing runs. Every function's limits
 * must stay at or under the cap, whatever the individual files ask for.
 */
describe("Inngest function concurrency", () => {
  type Opts = { id: string; concurrency?: number | { limit: number } | { limit: number }[] };
  const limitsOf = (c: Opts["concurrency"]): number[] => (c === undefined ? [] : typeof c === "number" ? [c] : Array.isArray(c) ? c.map((x) => x.limit) : [c.limit]);

  it("caps a wider request at the plan's limit and leaves a narrower one alone", () => {
    expect(concurrencyCap(20)).toBe(PLAN_CONCURRENCY);
    expect(concurrencyCap(1)).toBe(1);
    expect(PLAN_CONCURRENCY).toBe(5);
  });

  it("registers no function above the plan's limit", () => {
    expect(functions.length).toBeGreaterThan(20);
    for (const fn of functions) {
      const opts = (fn as unknown as { opts: Opts }).opts;
      for (const limit of limitsOf(opts.concurrency)) expect({ id: opts.id, limit }).toEqual({ id: opts.id, limit: Math.min(limit, PLAN_CONCURRENCY) });
    }
  });
});
