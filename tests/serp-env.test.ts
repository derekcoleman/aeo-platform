import { afterEach, describe, expect, it, vi } from "vitest";
import { envChecks } from "@/lib/ops/setup";
import { dataForSeoProvider } from "@/lib/serp/dataforseo";
import { aioVendorPreference, configuredSerpVendors, dataForSeoConfigured, serpApiKey, serpConfigured, vendorCostUsd } from "@/lib/serp/env";
import { serpApiProvider } from "@/lib/serp/serpapi";

const env = (vars: Record<string, string>) => ({ ...vars, NODE_ENV: "test" as const });

describe("SERP credentials", () => {
  it("reads SERPAPI_API_KEY first and falls back to the deprecated SERPAPI_KEY", () => {
    expect(serpApiKey(env({ SERPAPI_API_KEY: "new", SERPAPI_KEY: "old" }))).toBe("new");
    expect(serpApiKey(env({ SERPAPI_KEY: " old " }))).toBe("old");
    expect(serpApiKey(env({ SERPAPI_API_KEY: "  " }))).toBeNull();
    expect(serpApiKey(env({}))).toBeNull();
  });

  it("counts DataForSEO only with both login and password", () => {
    expect(dataForSeoConfigured(env({ DATAFORSEO_LOGIN: "me" }))).toBe(false);
    expect(dataForSeoConfigured(env({ DATAFORSEO_LOGIN: "me", DATAFORSEO_PASSWORD: "pw" }))).toBe(true);
    expect(serpConfigured(env({ DATAFORSEO_LOGIN: "me" }))).toBe(false);
    expect(serpConfigured(env({ SERPAPI_KEY: "old" }))).toBe(true);
    expect(configuredSerpVendors(env({ DATAFORSEO_LOGIN: "me", DATAFORSEO_PASSWORD: "pw", SERPAPI_API_KEY: "k" }))).toEqual(["dataforseo", "serpapi"]);
  });

  it("honours an AIO vendor pin only for a configured vendor", () => {
    const both = { DATAFORSEO_LOGIN: "me", DATAFORSEO_PASSWORD: "pw", SERPAPI_API_KEY: "k" };
    expect(aioVendorPreference(env({ ...both, AEO_SERP_AIO_PROVIDER: "DataForSEO" }))).toBe("dataforseo");
    expect(aioVendorPreference(env({ ...both }))).toBeNull();
    expect(aioVendorPreference(env({ SERPAPI_API_KEY: "k", AEO_SERP_AIO_PROVIDER: "dataforseo" }))).toBeNull();
    expect(aioVendorPreference(env({ ...both, AEO_SERP_AIO_PROVIDER: "bing" }))).toBeNull();
  });

  it("the setup checklist agrees with the client about what is configured", () => {
    const serp = (vars: Record<string, string>) => envChecks(env(vars)).find((c) => c.key === "env.serp")!;
    expect(serp({ DATAFORSEO_LOGIN: "me" })).toMatchObject({ state: "warn", fix: expect.stringContaining("SERPAPI_API_KEY") });
    expect(serp({ SERPAPI_API_KEY: "k" })).toMatchObject({ state: "ok", detail: "serpapi configured" });
    expect(serp({ SERPAPI_KEY: "k" })).toMatchObject({ state: "warn", fix: "Rename SERPAPI_KEY to SERPAPI_API_KEY." });
    expect(serp({ DATAFORSEO_LOGIN: "me", DATAFORSEO_PASSWORD: "pw" })).toMatchObject({ state: "ok", detail: "dataforseo configured" });
  });
});

describe("SERP cost overrides", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats a blank, malformed or negative override as unset, and keeps an explicit one", () => {
    expect(vendorCostUsd("X", 0.01, env({}))).toBe(0.01);
    expect(vendorCostUsd("X", 0.01, env({ X: "" }))).toBe(0.01);
    expect(vendorCostUsd("X", 0.01, env({ X: "  " }))).toBe(0.01);
    expect(vendorCostUsd("X", 0.01, env({ X: "abc" }))).toBe(0.01);
    expect(vendorCostUsd("X", 0.01, env({ X: "-1" }))).toBe(0.01);
    expect(vendorCostUsd("X", 0.01, env({ X: "0.025" }))).toBe(0.025);
    expect(vendorCostUsd("X", 0.01, env({ X: "0" }))).toBe(0);
  });

  it("a copied .env.example (NAME= lines) still records what each call costs", async () => {
    vi.stubEnv("SERPAPI_SEARCH_COST_USD", "");
    vi.stubEnv("DATAFORSEO_SERP_COST_USD", "");
    vi.stubEnv("DATAFORSEO_AUTOCOMPLETE_COST_USD", "");
    const q = { query: "x", locale: { country: "us", language: "en" }, device: "desktop" as const };
    const sa = (async () => new Response(JSON.stringify({ organic_results: [] }), { status: 200 })) as unknown as typeof fetch;
    expect((await serpApiProvider({ apiKey: "k", fetchImpl: sa }).serp(q)).costUsd).toBe(0.01);
    // A DataForSEO task that reports no cost falls back to the estimate.
    const dfs = (async () => new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ keyword: "x", items: [] }] }] }), { status: 200 })) as unknown as typeof fetch;
    expect((await dataForSeoProvider({ login: "l", password: "p", fetchImpl: dfs }).serp(q)).costUsd).toBe(0.002);
  });
});
