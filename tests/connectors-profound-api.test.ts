import { describe, expect, it } from "vitest";
import { ProfoundApi, ProfoundApiError, normalizeAnswerRows, normalizeCategories, reportRows } from "@/lib/connectors/profound/api";

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
  it("authenticates with the key, posts the report body, follows cursors and surfaces API errors", async () => {
    const calls: { url: string; auth: string; body: Record<string, unknown> | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).authorization), body });
      if (String(url).endsWith("/categories")) return new Response(JSON.stringify({ data: [{ id: "c1", name: "Identity" }] }), { status: 200 });
      if (String(url).endsWith("/reports/answers")) {
        if (!body?.cursor) return new Response(JSON.stringify({ data: [{ prompt: "p1", platform: "chatgpt", date: "2026-09-01" }], next_cursor: "page2" }), { status: 200 });
        return new Response(JSON.stringify({ data: [{ prompt: "p2", platform: "chatgpt", date: "2026-09-01" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
    }) as typeof fetch;
    const api = new ProfoundApi({ apiKey: "pk", baseUrl: "https://api.example.test/v1/", fetchImpl });
    expect(await api.categories()).toEqual([{ id: "c1", name: "Identity", organization: null }]);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/categories");
    expect(calls[0]!.auth).toBe("Bearer pk");
    const r = await api.answers({ categoryId: "c1", startDate: "2026-08-01", endDate: "2026-09-01" });
    expect(r.records.map((x) => x.prompt)).toEqual(["p1", "p2"]);
    expect(r.pages).toBe(2);
    expect(calls[1]!.body).toMatchObject({ category_id: "c1", start_date: "2026-08-01", end_date: "2026-09-01", include_citations: true });
    const other = new ProfoundApi({ apiKey: "pk", baseUrl: "https://api.example.test/v1", endpoints: { categories: "/orgs" }, fetchImpl });
    await expect(other.categories()).rejects.toBeInstanceOf(ProfoundApiError);
  });
});
