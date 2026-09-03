import { describe, expect, it } from "vitest";
import {
  GSC_LAG_DAYS,
  engineForSource,
  ga4Date,
  googleOAuthFromEnv,
  googleWindow,
  normalizeGa4Rows,
  normalizeGscRows,
  pageUnderPrefix,
} from "@/lib/connectors/google";
import { ConnectorError } from "@/lib/connectors/types";

const NOW = new Date("2026-09-01T12:00:00Z");

describe("googleWindow", () => {
  it("backfills 16 months ending at the GSC lag boundary", () => {
    const w = googleWindow("backfill", null, NOW);
    expect(w).toEqual({ startDate: "2025-05-01", endDate: "2026-08-29" });
    expect(GSC_LAG_DAYS).toBe(3);
  });

  it("falls back to backfill when there is no cursor", () => {
    expect(googleWindow("incremental", null, NOW).startDate).toBe("2025-05-01");
  });

  it("re-reads a trailing week from the cursor on incremental", () => {
    expect(googleWindow("incremental", { through: "2026-08-25" }, NOW)).toEqual({ startDate: "2026-08-18", endDate: "2026-08-29" });
  });
});

describe("googleOAuthFromEnv", () => {
  it("requires all three settings", () => {
    expect(() => googleOAuthFromEnv({ NODE_ENV: "test", GOOGLE_OAUTH_CLIENT_ID: "id" })).toThrow(ConnectorError);
    expect(googleOAuthFromEnv({ NODE_ENV: "test", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s", GOOGLE_OAUTH_REDIRECT_URI: "https://x/cb" })).toMatchObject({ clientId: "id", redirectUri: "https://x/cb" });
  });
});

describe("Search Console normalisation", () => {
  it("pageUnderPrefix matches the prefix as a path segment, not a substring", () => {
    expect(pageUnderPrefix("https://acme.com/resources/x", "/resources")).toBe(true);
    expect(pageUnderPrefix("https://acme.com/resources", "/resources/")).toBe(true);
    expect(pageUnderPrefix("https://acme.com/resources-old/x", "/resources")).toBe(false);
    expect(pageUnderPrefix("https://acme.com/anything", "/")).toBe(true);
    expect(pageUnderPrefix("not a url", "/resources")).toBe(false);
  });

  it("emits one external_metrics row per GSC row, filtered to the prefix", () => {
    const rows = normalizeGscRows(
      [
        { keys: ["2026-08-20", "okta vs entra", "https://acme.com/resources/sso"], clicks: 3, impressions: 120, ctr: 0.025, position: 7.4321 },
        { keys: ["2026-08-20", "acme pricing", "https://acme.com/pricing"], clicks: 30, impressions: 200, ctr: 0.15, position: 1.2 },
      ],
      ["date", "query", "page"],
      "/resources",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      provider: "gsc",
      surface: "gsc_query_page",
      dimension: { query: "okta vs entra", page: "https://acme.com/resources/sso" },
      date: "2026-08-20",
      metrics: { clicks: 3, impressions: 120, ctr: 0.025, position: 7.43 },
    });
    expect(normalizeGscRows([{ keys: ["2026-08-20", "q"], clicks: 1, impressions: 1, ctr: 1, position: 1 }], ["date", "query"])[0]?.surface).toBe("gsc_query");
    expect(() => normalizeGscRows([], ["query"])).toThrow(/date dimension/);
  });
});

describe("GA4 normalisation", () => {
  it("maps referrer sources to engines, including subdomains and paths", () => {
    expect(engineForSource("chatgpt.com")).toBe("chatgpt");
    expect(engineForSource("https://www.perplexity.ai/")).toBe("perplexity");
    expect(engineForSource("m.chatgpt.com")).toBe("chatgpt");
    expect(engineForSource("bing.com/chat/x")).toBe("copilot");
    expect(engineForSource("google")).toBeNull();
  });

  it("ga4Date converts the compact form only", () => {
    expect(ga4Date("20260901")).toBe("2026-09-01");
    expect(ga4Date("2026-09-01")).toBe("2026-09-01");
  });

  it("keeps only nameable AI sources and strips query strings from landing pages", () => {
    const rows = normalizeGa4Rows([
      { dimensionValues: [{ value: "20260820" }, { value: "chatgpt.com" }, { value: "/resources/sso?utm=x" }], metricValues: [{ value: "12" }, { value: "9" }, { value: "1" }, { value: "11" }] },
      { dimensionValues: [{ value: "20260820" }, { value: "google" }, { value: "/" }], metricValues: [{ value: "500" }, { value: "1" }, { value: "1" }, { value: "1" }] },
    ]);
    expect(rows).toEqual([
      {
        provider: "ga4",
        surface: "ga4_referral",
        dimension: { engine: "chatgpt", source: "chatgpt.com", landingPage: "/resources/sso" },
        date: "2026-08-20",
        metrics: { sessions: 12, engagedSessions: 9, conversions: 1, totalUsers: 11 },
      },
    ]);
  });
});
