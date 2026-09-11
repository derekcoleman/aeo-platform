import { describe, expect, it } from "vitest";
import { ProfoundApi, ProfoundDiscoveryError, normalizeAnswerRows, normalizeCategories, reportRows } from "@/lib/connectors/profound/api";

describe("normalizeAnswerRows", () => {
  it("accepts the field spellings the reports use and drops rows without a prompt or date", () => {
    const { records, dropped } = normalizeAnswerRows([
      { prompt: "best scim tools", platform: "ChatGPT", date: "2026-09-01", brand_mentioned: true, visibility: 42.5, citations: [{ url: "https://okta.com/a", position: 2 }, "https://acme.com/resources/x"] },
      { prompt_text: "sso vs scim", engine: "Perplexity", day: "2026-09-02T10:00:00Z", mentioned: "false", share_of_voice: "12", sources: ["not a url"] },
      { platform: "Gemini", date: "2026-09-01" },
      { prompt: "no date", platform: "ChatGPT" },
    ]);
    expect(dropped).toBe(2);
    expect(records[0]).toMatchObject({ prompt: "best scim tools", engine: "chatgpt", date: "2026-09-01", brandMentioned: true, visibility: 42.5 });
    expect(records[0]!.citations).toEqual([{ url: "https://okta.com/a", domain: "okta.com", position: 2 }, { url: "https://acme.com/resources/x", domain: "acme.com", position: 2 }]);
    expect(records[1]).toMatchObject({ prompt: "sso vs scim", engine: "perplexity", date: "2026-09-02", brandMentioned: false, visibility: 12, citations: [] });
  });
});

describe("reportRows + categories", () => {
  it("finds the data array wherever the response nests it", () => {
    expect(reportRows([{ a: 1 }])).toHaveLength(1);
    expect(reportRows({ data: [{ a: 1 }, { a: 2 }] })).toHaveLength(2);
    expect(reportRows({ data: { rows: [{ a: 1 }] } })).toHaveLength(1);
    expect(reportRows({ nope: 1 })).toEqual([]);
    expect(normalizeCategories({ categories: [{ category_id: "c1", category_name: "Identity" }, { id: "", name: "x" }] })).toEqual([{ id: "c1", name: "Identity", organization: null }]);
  });
});

describe("ProfoundApi", () => {
  it("sends the key in X-API-Key, hits Profound's real paths, pages the v1 answers report by offset and surfaces API errors", async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
      if (String(url).endsWith("/v1/org/categories")) return new Response(JSON.stringify([{ id: "c1", name: "Identity", organization: { id: "o1", name: "Acme Inc" } }]), { status: 200 });
      if (String(url).endsWith("/v1/prompts/answers")) {
        const offset = (body!.pagination as { offset: number }).offset;
        const rows = offset === 0 ? [{ prompt: "p1", model: "ChatGPT", created_at: "2026-09-01T12:00:00Z", asset: "Acme", mentions: ["Acme", "Okta"], citation_details: [{ url: "https://okta.com/a", hostname: "okta.com" }] }, { prompt: "p2", model: "Perplexity", created_at: "2026-09-01T13:00:00Z", asset: "Acme", mentions: ["Okta"], citations: ["https://acme.com/x"] }] : [{ prompt: "p3", model: { id: "m1", name: "Google AI Overviews" }, created_at: "2026-09-02T00:00:00Z", asset: "Acme", mentions: [] }];
        return new Response(JSON.stringify({ info: { total_rows: 3 }, data: rows }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    }) as typeof fetch;
    const api = new ProfoundApi({ apiKey: "pk", fetchImpl });
    expect(await api.categories()).toEqual([{ id: "c1", name: "Identity", organization: "Acme Inc" }]);
    expect(calls[0]!.url).toBe("https://api.tryprofound.com/v1/org/categories");
    expect(calls[0]!.headers["x-api-key"]).toBe("pk");
    expect(calls[0]!.headers.authorization).toBeUndefined();

    const r = await api.answers({ categoryId: "c1", startDate: "2026-08-01", endDate: "2026-09-02", limit: 2 });
    expect(r.pages).toBe(2);
    expect(calls[1]!.body).toMatchObject({ category_id: "c1", start_date: "2026-08-01T00:00:00.000Z", end_date: "2026-09-02T23:59:59.999Z", pagination: { limit: 2, offset: 0 } });
    expect((calls[1]!.body!.include as Record<string, boolean>).response).toBe(false);
    expect(calls[2]!.body).toMatchObject({ pagination: { limit: 2, offset: 2 } });
    expect(r.records.map((x) => [x.prompt, x.engine, x.date, x.brandMentioned])).toEqual([
      ["p1", "chatgpt", "2026-09-01", true],
      ["p2", "perplexity", "2026-09-01", false],
      ["p3", "google_aio", "2026-09-02", false],
    ]);
    expect(r.records[0]!.citations).toEqual([{ url: "https://okta.com/a", domain: "okta.com", position: 1 }]);
    expect(r.records[1]!.citations).toEqual([{ url: "https://acme.com/x", domain: "acme.com", position: 1 }]);
    expect(r.records[0]!.raw.mentions).toBe("Acme|Okta");
    expect(r.records[0]!.raw.response).toBeUndefined();

    const other = new ProfoundApi({ apiKey: "pk", endpoints: { categories: "/v1/orgs" }, fetchImpl });
    await expect(other.categories()).rejects.toMatchObject({ status: 404, message: "profound /v1/orgs: Not Found" });
  });

  it("joins a versioned base and a versioned path without doubling the segment", () => {
    expect(ProfoundApi.joinUrl("https://api.tryprofound.com/v1", "/v1/org/categories")).toBe("https://api.tryprofound.com/v1/org/categories");
    expect(ProfoundApi.joinUrl("https://api.tryprofound.com", "/v1/org/categories")).toBe("https://api.tryprofound.com/v1/org/categories");
    expect(ProfoundApi.joinUrl("https://api.tryprofound.com/v1", "/categories")).toBe("https://api.tryprofound.com/v1/categories");
  });
});

describe("ProfoundApi.discoverCategories", () => {
  const server = (routes: Record<string, number | unknown>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      const r = routes[key];
      if (r === undefined) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
      if (typeof r === "number") return new Response(JSON.stringify({ detail: "nope" }), { status: r });
      return new Response(JSON.stringify(r), { status: 200 });
    }) as typeof fetch;

  it("returns the configured path when it answers", async () => {
    const api = new ProfoundApi({ apiKey: "k", baseUrl: "https://api.example.test", fetchImpl: server({ "GET /v1/org/categories": [{ id: "c1", name: "Identity" }] }) });
    const d = await api.discoverCategories();
    expect(d.path).toBe("/v1/org/categories");
    expect(d.baseUrl).toBe("https://api.example.test");
    expect(d.categories).toHaveLength(1);
    expect(d.attempts).toHaveLength(1);
  });

  it("walks the alternatives after a 404 and persists what answered, even from a stale versioned base", async () => {
    const api = new ProfoundApi({ apiKey: "k", baseUrl: "https://api.example.test/v1", fetchImpl: server({ "GET /v1/orgs": { data: [{ id: "o1", name: "Acme" }] } }) });
    const d = await api.discoverCategories();
    expect(d.path).toBe("/v1/orgs");
    expect(d.categories).toEqual([{ id: "o1", name: "Acme", organization: null }]);
    expect(d.attempts.every((a) => a.status === 404 || a.url === "https://api.example.test/v1/orgs")).toBe(true);
    expect(new Set(d.attempts.map((a) => a.url)).size).toBe(d.attempts.length);
  });

  it("stops at a 401: the path exists and the key is the problem", async () => {
    const api = new ProfoundApi({ apiKey: "k", baseUrl: "https://api.example.test", fetchImpl: server({ "GET /v1/org/categories": 404, "GET /v1/categories": 401 }) });
    await expect(api.discoverCategories()).rejects.toMatchObject({ status: 401 });
  });

  it("reports every attempt when nothing answers", async () => {
    const api = new ProfoundApi({ apiKey: "k", baseUrl: "https://api.example.test", fetchImpl: server({}) });
    const err = await api.discoverCategories().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfoundDiscoveryError);
    expect((err as ProfoundDiscoveryError).attempts.length).toBe(5);
    expect((err as ProfoundDiscoveryError).attempts[0]).toMatchObject({ url: "https://api.example.test/v1/org/categories", status: 404 });
  });

  it("verifyReport posts a one-row, one-day answers query for the category", async () => {
    let body: Record<string, unknown> | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(url)).toBe("https://api.tryprofound.com/v1/prompts/answers");
      return new Response(JSON.stringify({ info: { total_rows: 1 }, data: [{ prompt: "p", model: "chatgpt", created_at: "2026-09-10T01:00:00Z" }] }), { status: 200 });
    }) as typeof fetch;
    const api = new ProfoundApi({ apiKey: "k", fetchImpl });
    expect(await api.verifyReport("c1", "2026-09-11")).toEqual({ rows: 1 });
    expect(body).toMatchObject({ category_id: "c1", start_date: "2026-09-10T00:00:00.000Z", end_date: "2026-09-11T23:59:59.999Z", pagination: { limit: 1, offset: 0 } });
  });
});
