import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  cacheKey,
  createSerpClient,
  dayOf,
  memoryBudget,
  memoryCache,
  type AutocompleteResult,
  type SerpProvider,
  type SerpQuery,
  type SerpResult,
} from "@/lib/serp";

const q: SerpQuery = { query: "  What is  SCIM? ", locale: { country: "US", language: "EN" }, device: "desktop" };
const tenant = { orgId: "11111111-1111-1111-1111-111111111111", siteId: null };

function fakeProvider(name: "dataforseo" | "serpapi", cost: number): SerpProvider & { calls: string[] } {
  const calls: string[] = [];
  const serp = (query: SerpQuery): SerpResult => ({
    provider: name, query: query.query, locale: query.locale, device: query.device, fetchedAt: new Date().toISOString(),
    organic: [], paa: [{ question: `${name} paa` }], featuredSnippet: null,
    aiOverview: { triggered: true, text: name, references: [] }, raw: null, costUsd: cost,
  });
  const ac = (query: SerpQuery): AutocompleteResult => ({ provider: name, query: query.query, suggestions: [`${name} suggestion`], fetchedAt: new Date().toISOString(), costUsd: cost / 4 });
  return {
    name,
    calls,
    async autocomplete(query) { calls.push(`ac:${query.query}`); return ac(query); },
    async serp(query) { calls.push(`serp:${query.query}`); return serp(query); },
    async paa(query) { calls.push(`paa:${query.query}`); return serp(query).paa; },
    async aiOverview(query) { calls.push(`aio:${query.query}`); return serp(query).aiOverview; },
  };
}

describe("cacheKey", () => {
  it("normalises query whitespace/case and locale, and is day-scoped", () => {
    const a = cacheKey("serpapi", "serp", q, "2026-09-01");
    const b = cacheKey("serpapi", "serp", { ...q, query: "what is scim?", locale: { country: "us", language: "en" } }, "2026-09-01");
    expect(a).toBe(b);
    expect(a).toBe("serpapi|serp|us-en|desktop|2026-09-01|what is scim?");
    expect(cacheKey("serpapi", "serp", q, "2026-09-02")).not.toBe(a);
    expect(cacheKey("serpapi", "serp", { ...q, device: "mobile" }, "2026-09-01")).not.toBe(a);
    expect(dayOf(new Date("2026-09-01T23:59:59Z"))).toBe("2026-09-01");
  });
});

describe("createSerpClient", () => {
  it("routes bulk calls to the cheap provider and AIO calls to the fidelity provider", async () => {
    const bulk = fakeProvider("dataforseo", 0.002);
    const aio = fakeProvider("serpapi", 0.02);
    const client = createSerpClient({ bulk, aio });
    expect(client.providers).toEqual({ bulk: "dataforseo", aio: "serpapi" });
    await client.autocomplete(q, tenant);
    await client.paa(q, tenant);
    const over = await client.aiOverview(q, tenant);
    expect(bulk.calls).toEqual(["ac:  What is  SCIM? ", "serp:  What is  SCIM? "]);
    expect(aio.calls).toEqual(["serp:  What is  SCIM? "]);
    expect(over?.text).toBe("serpapi");
  });

  it("serves a same-day repeat from cache without a second provider call or spend", async () => {
    const bulk = fakeProvider("dataforseo", 0.002);
    const budget = memoryBudget({});
    const cache = memoryCache();
    const client = createSerpClient({ bulk, cache, budget, now: () => new Date("2026-09-01T10:00:00Z") });
    const first = await client.serp(q, tenant);
    const second = await client.serp({ ...q, query: "what is scim?" }, tenant);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(bulk.calls).toHaveLength(1);
    expect(cache.size).toBe(1);
    expect(budget.spent[tenant.orgId]).toBeCloseTo(0.002);
    expect(budget.records.map((r) => r.cached)).toEqual([false, true]);
  });

  it("re-fetches on a new day", async () => {
    const bulk = fakeProvider("dataforseo", 0.002);
    let day = "2026-09-01";
    const client = createSerpClient({ bulk, now: () => new Date(`${day}T10:00:00Z`) });
    await client.serp(q, tenant);
    day = "2026-09-02";
    await client.serp(q, tenant);
    expect(bulk.calls).toHaveLength(2);
  });

  it("refuses the call before spending when the org budget would be exceeded", async () => {
    const bulk = fakeProvider("dataforseo", 0.002);
    const budget = memoryBudget({ [tenant.orgId]: 0.02 });
    const client = createSerpClient({ bulk, budget, estimate: { dataforseo: { serp: 0.02, autocomplete: 0.02 } } });
    await client.serp(q, tenant);
    await expect(client.serp({ ...q, query: "another" }, tenant)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(bulk.calls).toHaveLength(1);
    expect(budget.spent[tenant.orgId]).toBeCloseTo(0.002);
  });

  it("budgets are per org", async () => {
    const bulk = fakeProvider("dataforseo", 1);
    const budget = memoryBudget({}, 1.5);
    const client = createSerpClient({ bulk, budget, estimate: { dataforseo: { serp: 1, autocomplete: 1 } } });
    await client.serp(q, tenant);
    await expect(client.serp({ ...q, query: "b" }, tenant)).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(client.serp({ ...q, query: "b" }, { orgId: "22222222-2222-2222-2222-222222222222" })).resolves.toBeTruthy();
  });
});
