import { describe, expect, it } from "vitest";
import { demandSeeds, mineLocale } from "@/lib/demand/seeds";
import { RetryableError } from "@/lib/fetch/retry";
import { MINE_SEED_BATCH, seedBatches, snapshotFailure } from "@/lib/inngest/demand";
import { BudgetExceededError, SerpProviderError } from "@/lib/serp";

const entity = (type: "brand" | "product" | "competitor" | "category", name: string, aliases: string[] = []) => ({ type, name, aliases });

describe("demandSeeds", () => {
  it("prefers tracked topics, then onboarding keywords, then the crawl's suggestions, and never our own names", () => {
    const seeds = demandSeeds({
      siteName: "Acme",
      keywords: ["scim provisioning", "Acme"],
      profile: { name: "Acme Identity", keywords: ["sso for mid-market", "SCIM provisioning", "AcmeSync"], products: [{ name: "AcmeSync", description: "" }] },
      topics: [{ name: "user provisioning", seed_terms: ["scim vs sso", "  user   provisioning "] }],
      entities: [entity("brand", "Acme Identity", ["acme"]), entity("product", "AcmeSync"), entity("category", "identity management"), entity("competitor", "Okta"), entity("competitor", "Entra")],
    });
    expect(seeds).toEqual(["user provisioning", "scim vs sso", "scim provisioning", "sso for mid-market", "identity management", "Okta alternative", "Entra alternative"]);
  });

  it("caps the list and the competitor share", () => {
    const seeds = demandSeeds({
      keywords: Array.from({ length: 40 }, (_, i) => `keyword ${i}`),
      entities: Array.from({ length: 10 }, (_, i) => entity("competitor", `Rival ${i}`)),
    });
    expect(seeds).toHaveLength(30);
    expect(seeds.filter((s) => s.endsWith(" alternative"))).toHaveLength(0);
    const few = demandSeeds({ keywords: ["a b"], entities: Array.from({ length: 10 }, (_, i) => entity("competitor", `Rival ${i}`)) });
    expect(few.filter((s) => s.endsWith(" alternative"))).toHaveLength(5);
  });

  it("is empty when nothing is known", () => {
    expect(demandSeeds({})).toEqual([]);
  });

  it("mineLocale reads country and language from the site locale", () => {
    expect(mineLocale("en-US")).toEqual({ country: "us", language: "en" });
    expect(mineLocale("de_DE")).toEqual({ country: "de", language: "de" });
    expect(mineLocale("fr")).toEqual({ country: "us", language: "fr" });
    expect(mineLocale(null)).toEqual({ country: "us", language: "en" });
  });
});

describe("seedBatches", () => {
  it("splits a seed list into batches of five, in order, one durable step each", () => {
    expect(MINE_SEED_BATCH).toBe(5);
    const seeds = Array.from({ length: 12 }, (_, i) => `seed ${i}`);
    const batches = seedBatches(seeds);
    expect(batches.map((b) => b.length)).toEqual([5, 5, 2]);
    expect(batches.flat()).toEqual(seeds);
    expect(seedBatches(["a"])).toEqual([["a"]]);
    expect(seedBatches([])).toEqual([]);
    expect(seedBatches(["a", "b", "c"], 0)).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("snapshotFailure", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  it("hands a transient failure back to the step's retry, and records it only on the last attempt", () => {
    for (const e of [timeout, new RetryableError("serpapi 503"), Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), new Error("connection terminated")]) {
      expect(snapshotFailure(e, 0)).toBe("retry");
      expect(snapshotFailure(e, 1)).toBe("retry");
      expect(snapshotFailure(e, 2)).toBe("record");
    }
  });

  it("records a refused query at once and stops the batch on the budget", () => {
    expect(snapshotFailure(new SerpProviderError("serpapi", "400 Unsupported location"), 0)).toBe("record");
    expect(snapshotFailure(new BudgetExceededError("org", 10, 10), 0)).toBe("budget");
    expect(snapshotFailure(new BudgetExceededError("org", 10, 10), 2)).toBe("budget");
  });
});
