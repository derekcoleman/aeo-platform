import { describe, expect, it } from "vitest";
import { memoryBudget, memoryCache, SerpProviderError } from "@/lib/serp";
import {
  DATAFORSEO_LABS_COST_USD,
  DATAFORSEO_LABS_TIMEOUT_MS,
  dataForSeoLabs,
  monthOf,
  parseRankedKeywords,
  rankedKeywordsCached,
  rankedKeywordsCacheKey,
  rankedKeywordsRequest,
  type DfsRankedKeywordsResult,
  type RankedKeywordsQuery,
} from "@/lib/serp/dataforseo-labs";
import { fakeFetch } from "./helpers/fake-fetch";

const URL_ = "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live";
const tenant = { orgId: "11111111-1111-1111-1111-111111111111", siteId: "aaaaaaaa-0000-0000-0000-000000000001" };
const q: RankedKeywordsQuery = { target: "https://www.Okta.com/", locale: { country: "us", language: "EN" }, maxRank: 10 };

const item = (keyword: string, rank: number, extra: { volume?: number | null; kd?: number | null; intent?: string | null; url?: string; type?: string } = {}) => ({
  keyword_data: {
    keyword,
    keyword_info: { search_volume: extra.volume === undefined ? 100 : extra.volume },
    keyword_properties: { keyword_difficulty: extra.kd === undefined ? 30 : extra.kd },
    search_intent_info: extra.intent === null ? null : { main_intent: extra.intent ?? "informational" },
  },
  ranked_serp_element: { serp_item: { type: extra.type ?? "organic", rank_group: rank, rank_absolute: rank + 2, url: extra.url ?? `https://www.okta.com/${keyword.replace(/\s+/g, "-")}` } },
});

const envelope = (result: DfsRankedKeywordsResult, cost = 0.1032, status = 20000) =>
  JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: status, status_message: status === 20000 ? "Ok." : "Invalid Field: 'location_code'.", cost, result: status === 20000 ? [result] : null }] });

describe("ranked keywords request", () => {
  it("asks for organic results up to the rank cut-off, highest volume first, on the normalised domain and market", () => {
    expect(rankedKeywordsRequest(q)).toEqual({
      target: "okta.com",
      location_code: 2840,
      language_code: "en",
      limit: 1000,
      item_types: ["organic"],
      filters: ["ranked_serp_element.serp_item.rank_group", "<=", 10],
      order_by: ["keyword_data.keyword_info.search_volume,desc"],
    });
    expect(rankedKeywordsRequest({ ...q, locale: { country: "gb", language: "en" }, limit: 5000 })).toMatchObject({ location_code: 2826, limit: 1000 });
  });

  it("caches per market, cut-off, limit, domain and month", () => {
    expect(rankedKeywordsCacheKey(q, "2026-10")).toBe("dataforseo|labs.ranked_keywords|2840-en|r10|n1000|okta.com|2026-10");
    expect(rankedKeywordsCacheKey({ ...q, target: "okta.com" }, "2026-10")).toBe(rankedKeywordsCacheKey(q, "2026-10"));
    expect(rankedKeywordsCacheKey({ ...q, maxRank: 20 }, "2026-10")).not.toBe(rankedKeywordsCacheKey(q, "2026-10"));
    expect(rankedKeywordsCacheKey(q, "2026-11")).not.toBe(rankedKeywordsCacheKey(q, "2026-10"));
    expect(monthOf(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
  });
});

describe("parseRankedKeywords", () => {
  it("keeps organic items within the cut-off, one per keyword at its best rank, highest volume first", () => {
    const r = parseRankedKeywords(
      {
        total_count: 4,
        items: [
          item("sso pricing", 4, { volume: 880, kd: 41, intent: "commercial" }),
          item("what is scim", 2, { volume: 5400, kd: 62.4 }),
          item("SSO  pricing", 2, { volume: 880, kd: 41, intent: "commercial" }),
          item("okta login", 12, { volume: 90000 }),
          item("okta stock", 3, { type: "featured_snippet" }),
          item("   ", 1),
          { keyword_data: { keyword: "no rank" }, ranked_serp_element: { serp_item: { type: "organic", rank_group: null } } },
          item("scim spec", 8, { volume: null, kd: null, intent: "comparison" }),
        ],
      },
      10,
    );
    expect(r.keywords).toEqual([
      { keyword: "what is scim", searchVolume: 5400, keywordDifficulty: 62, searchIntent: "informational", rank: 2, url: "https://www.okta.com/what-is-scim" },
      { keyword: "SSO pricing", searchVolume: 880, keywordDifficulty: 41, searchIntent: "commercial", rank: 2, url: "https://www.okta.com/SSO-pricing" },
      // The vendor gave no volume, difficulty or a known intent: null, not zero.
      { keyword: "scim spec", searchVolume: null, keywordDifficulty: null, searchIntent: null, rank: 8, url: "https://www.okta.com/scim-spec" },
    ]);
    expect(r.total).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it("is truncated only when the page came back full at the limit with more behind it", () => {
    const items = [item("a b", 1), item("c d", 2)];
    expect(parseRankedKeywords({ total_count: 5000, items }, 10, 2).truncated).toBe(true);
    expect(parseRankedKeywords({ total_count: 2, items }, 10, 2).truncated).toBe(false);
    expect(parseRankedKeywords({ total_count: 5000, items }, 10, 1000).truncated).toBe(false);
    expect(parseRankedKeywords({ items: null }, 10)).toEqual({ total: 0, truncated: false, keywords: [] });
  });
});

describe("dataForSeoLabs", () => {
  it("posts one task with basic auth and a deadline, and settles at the task's reported cost", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const ff = fakeFetch({ [URL_]: { body: envelope({ total_count: 1, items: [item("scim provisioning", 3, { volume: 720, intent: "commercial" })] }) } });
    const labs = dataForSeoLabs({
      login: "l",
      password: "p",
      fetchImpl: (async (input: string, init?: RequestInit) => {
        signals.push(init?.signal);
        return ff.fetchImpl(input, init);
      }) as typeof fetch,
    });
    const r = await labs.rankedKeywords(q);
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]!.method).toBe("POST");
    expect(ff.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from("l:p").toString("base64")}`);
    expect(JSON.parse(ff.calls[0]!.body!)).toEqual([rankedKeywordsRequest(q)]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(DATAFORSEO_LABS_TIMEOUT_MS).toBe(60_000);
    expect(r).toMatchObject({ provider: "dataforseo", target: "https://www.Okta.com/", locationCode: 2840, languageCode: "en", localeFallback: false, maxRank: 10, total: 1, costUsd: 0.1032 });
    expect(r.keywords.map((k) => k.keyword)).toEqual(["scim provisioning"]);
  });

  it("falls back to the estimate when the task reports no cost; DATAFORSEO_LABS_COST_USD sets the estimate", async () => {
    const ff = fakeFetch({ [URL_]: { body: envelope({ total_count: 0, items: [] }, 0) } });
    const prev = process.env.DATAFORSEO_LABS_COST_USD;
    try {
      delete process.env.DATAFORSEO_LABS_COST_USD;
      expect(dataForSeoLabs({ login: "l", password: "p" }).estimateUsd).toBe(DATAFORSEO_LABS_COST_USD);
      process.env.DATAFORSEO_LABS_COST_USD = "0.3";
      const labs = dataForSeoLabs({ login: "l", password: "p", fetchImpl: ff.fetchImpl });
      expect(labs.estimateUsd).toBe(0.3);
      expect((await labs.rankedKeywords(q)).costUsd).toBe(0.3);
      process.env.DATAFORSEO_LABS_COST_USD = "";
      expect(dataForSeoLabs({ login: "l", password: "p" }).estimateUsd).toBe(DATAFORSEO_LABS_COST_USD);
    } finally {
      if (prev === undefined) delete process.env.DATAFORSEO_LABS_COST_USD;
      else process.env.DATAFORSEO_LABS_COST_USD = prev;
    }
  });

  it("flags rankings for an unknown country as the US fallback", async () => {
    const ff = fakeFetch({ [URL_]: { body: envelope({ total_count: 0, items: [] }) } });
    const r = await dataForSeoLabs({ login: "l", password: "p", fetchImpl: ff.fetchImpl }).rankedKeywords({ ...q, locale: { country: "zz", language: "en" } });
    expect(JSON.parse(ff.calls[0]!.body!)[0]).toMatchObject({ location_code: 2840 });
    expect(r.localeFallback).toBe(true);
  });

  it("a task the vendor refused is a provider error with its status, not retried", async () => {
    const ff = fakeFetch({ [URL_]: { body: envelope({}, 0, 40501) } });
    const err = await dataForSeoLabs({ login: "l", password: "p", fetchImpl: ff.fetchImpl }).rankedKeywords(q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerpProviderError);
    expect((err as SerpProviderError).status).toBe(40501);
    expect(ff.calls).toHaveLength(1);
  });

  it("a timed-out call is not retried in-process (the job step is)", async () => {
    let calls = 0;
    const timingOut = (async () => {
      calls += 1;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await expect(dataForSeoLabs({ login: "l", password: "p", fetchImpl: timingOut }).rankedKeywords(q)).rejects.toThrow(/timeout/);
    expect(calls).toBe(1);
  });

  it("refuses to call without credentials", async () => {
    const prev = { l: process.env.DATAFORSEO_LOGIN, p: process.env.DATAFORSEO_PASSWORD };
    try {
      delete process.env.DATAFORSEO_LOGIN;
      delete process.env.DATAFORSEO_PASSWORD;
      await expect(dataForSeoLabs({ fetchImpl: fakeFetch({}).fetchImpl }).rankedKeywords(q)).rejects.toThrow(/DATAFORSEO_LOGIN/);
    } finally {
      if (prev.l !== undefined) process.env.DATAFORSEO_LOGIN = prev.l;
      if (prev.p !== undefined) process.env.DATAFORSEO_PASSWORD = prev.p;
    }
  });
});

describe("rankedKeywordsCached", () => {
  it("pays once a month through the SERP budget, then reads the month's cache at no cost", async () => {
    const ff = fakeFetch({ [URL_]: { body: envelope({ total_count: 1, items: [item("scim provisioning", 3)] }, 0.1001) } });
    const labs = dataForSeoLabs({ login: "l", password: "p", fetchImpl: ff.fetchImpl });
    const cache = memoryCache();
    const budget = memoryBudget({});
    const first = await rankedKeywordsCached(q, tenant, { labs, cache, budget, month: "2026-10" });
    const again = await rankedKeywordsCached({ ...q, target: "okta.com" }, tenant, { labs, cache, budget, month: "2026-10" });
    expect(first.cached).toBe(false);
    expect(again.cached).toBe(true);
    expect(again.keywords).toEqual(first.keywords);
    expect(ff.calls).toHaveLength(1);
    expect(budget.records.map((r) => [r.provider, r.method, r.query, r.costUsd, r.cached])).toEqual([
      ["dataforseo", "labs.ranked_keywords", "https://www.Okta.com/", 0.1001, false],
      ["dataforseo", "labs.ranked_keywords", "okta.com", 0, true],
    ]);
    expect(budget.spent[tenant.orgId]).toBeCloseTo(0.1001);
    await rankedKeywordsCached(q, tenant, { labs, cache, budget, month: "2026-11" });
    expect(ff.calls).toHaveLength(2);
  });

  it("holds the estimate before the call: a spent budget refuses it before anything is paid", async () => {
    const ff = fakeFetch({ [URL_]: { body: envelope({ total_count: 0, items: [] }) } });
    const labs = dataForSeoLabs({ login: "l", password: "p", fetchImpl: ff.fetchImpl });
    const budget = memoryBudget({ [tenant.orgId]: 0.05 });
    await expect(rankedKeywordsCached(q, tenant, { labs, cache: memoryCache(), budget, month: "2026-10" })).rejects.toThrow(/serp budget exceeded/);
    expect(ff.calls).toHaveLength(0);
  });

  it("gives the hold back and caches nothing when the call fails", async () => {
    const ff = fakeFetch({ [URL_]: { body: envelope({}, 0, 40501) } });
    const labs = dataForSeoLabs({ login: "l", password: "p", fetchImpl: ff.fetchImpl });
    const cache = memoryCache();
    const released: unknown[] = [];
    const budget = { ...memoryBudget({}), async reserve() { return { id: "hold-1", orgId: tenant.orgId, siteId: tenant.siteId, resource: "serp" as const, estimateUsd: 0.12 }; }, async release(r: unknown) { released.push(r); } };
    await expect(rankedKeywordsCached(q, tenant, { labs, cache, budget, month: "2026-10" })).rejects.toBeInstanceOf(SerpProviderError);
    expect(released).toEqual([expect.objectContaining({ id: "hold-1" })]);
    expect(cache.size).toBe(0);
  });
});
