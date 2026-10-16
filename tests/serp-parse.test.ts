import { describe, expect, it } from "vitest";
import { DATAFORSEO_TIMEOUTS_MS, dataForSeoProvider, locationCode, parseDataForSeoAutocomplete, parseDataForSeoSerp } from "@/lib/serp/dataforseo";
import { parseSerpApiAiOverview, parseSerpApiSerp, SERPAPI_TIMEOUT_MS, serpApiProvider, type SaSearch } from "@/lib/serp/serpapi";
import { domainOf, retryUnlessTimedOut } from "@/lib/serp/types";

describe("domainOf", () => {
  it("strips www and lowercases", () => {
    expect(domainOf("https://WWW.Acme.com/x")).toBe("acme.com");
    expect(domainOf("not a url")).toBe("");
  });
});

describe("DataForSEO parser", () => {
  const fixture = {
    keyword: "what is scim",
    items: [
      {
        type: "ai_overview",
        items: [
          { type: "ai_overview_element", text: "SCIM is a provisioning standard.", references: [{ url: "https://okta.com/scim", title: "Okta", domain: "okta.com" }] },
          { type: "ai_overview_element", text: "It automates lifecycle.", references: [{ url: "https://okta.com/scim" }, { url: "https://www.acme.com/resources/scim", title: "Acme" }] },
        ],
      },
      { type: "featured_snippet", url: "https://auth0.com/scim", title: "Auth0", description: "SCIM…" },
      { type: "organic", url: "https://okta.com/scim", domain: "okta.com", title: "Okta SCIM", description: "…" },
      { type: "organic", url: "https://www.acme.com/resources/scim", title: "Acme" },
      { type: "organic" },
      {
        type: "people_also_ask",
        items: [
          { type: "people_also_ask_element", title: "Does SCIM require SSO?", expanded_element: [{ type: "people_also_ask_expanded_element", url: "https://okta.com/faq", title: "Okta FAQ", description: "No, but…" }] },
          { type: "people_also_ask_element" },
        ],
      },
    ],
  };

  it("maps every surface and dedupes AIO references across sub-items", () => {
    const r = parseDataForSeoSerp(fixture);
    expect(r.aiOverview).toEqual({
      triggered: true,
      text: "SCIM is a provisioning standard.\n\nIt automates lifecycle.",
      references: [
        { position: 1, url: "https://okta.com/scim", domain: "okta.com", title: "Okta" },
        { position: 2, url: "https://www.acme.com/resources/scim", domain: "acme.com", title: "Acme" },
      ],
    });
    expect(r.featuredSnippet?.domain).toBe("auth0.com");
    expect(r.organic.map((o) => [o.position, o.domain])).toEqual([[1, "okta.com"], [2, "acme.com"]]);
    expect(r.paa).toEqual([{ question: "Does SCIM require SSO?", answerSnippet: "No, but…", sourceUrl: "https://okta.com/faq", sourceTitle: "Okta FAQ" }]);
  });

  it("reports triggered:false when no ai_overview item is present", () => {
    const r = parseDataForSeoSerp({ keyword: "x", items: [{ type: "organic", url: "https://a.com" }] });
    expect(r.aiOverview).toEqual({ triggered: false, text: null, references: [] });
    expect(r.paa).toEqual([]);
    expect(r.featuredSnippet).toBeNull();
  });

  it("dedupes autocomplete suggestions", () => {
    expect(parseDataForSeoAutocomplete({ keyword: "scim", items: [{ suggestion: "scim vs sso" }, { suggestion: "scim vs sso" }, {}, { suggestion: "scim pricing" }] }))
      .toEqual(["scim vs sso", "scim pricing"]);
  });
});

describe("SerpApi parser", () => {
  it("returns triggered:false when the field is absent", () => {
    expect(parseSerpApiAiOverview(undefined)).toEqual({ triggered: false, text: null, references: [] });
  });

  it("returns pending when only a page_token is present", () => {
    expect(parseSerpApiAiOverview({ page_token: "abc" })).toBe("pending");
  });

  it("returns null on a provider-side error", () => {
    expect(parseSerpApiAiOverview({ error: "Google hasn't returned any results" })).toBeNull();
  });

  it("joins text blocks and list items, dedupes references", () => {
    const aio = parseSerpApiAiOverview({
      text_blocks: [
        { type: "paragraph", snippet: "SCIM automates provisioning." },
        { type: "list", list: [{ snippet: "Creates users" }, { snippet: "Removes users" }] },
      ],
      references: [
        { link: "https://okta.com/scim", title: "Okta" },
        { link: "https://okta.com/scim", title: "dup" },
        { link: "https://www.acme.com/resources/scim", source: "Acme" },
        { title: "no link" },
      ],
    });
    expect(aio).not.toBe("pending");
    expect(aio && aio !== "pending" ? aio.text : null).toBe("SCIM automates provisioning.\n- Creates users\n- Removes users");
    expect(aio && aio !== "pending" ? aio.references : []).toEqual([
      { position: 1, url: "https://okta.com/scim", domain: "okta.com", title: "Okta" },
      { position: 2, url: "https://www.acme.com/resources/scim", domain: "acme.com", title: "Acme" },
    ]);
  });

  it("maps organic, related questions and the answer box", () => {
    const data: SaSearch = {
      organic_results: [{ position: 1, link: "https://okta.com/a", title: "A" }, { link: "https://www.acme.com/b", title: "B", snippet: "s" }, { title: "no link" }],
      related_questions: [{ question: "Is SCIM free?", snippet: "Usually.", link: "https://x.com/f", title: "X" }, {}],
      answer_box: { link: "https://auth0.com/fs", title: "Auth0", answer: "Yes" },
    };
    const r = parseSerpApiSerp(data);
    expect(r.organic.map((o) => [o.position, o.domain])).toEqual([[1, "okta.com"], [2, "acme.com"]]);
    expect(r.paa).toEqual([{ question: "Is SCIM free?", answerSnippet: "Usually.", sourceUrl: "https://x.com/f", sourceTitle: "X" }]);
    expect(r.featuredSnippet).toEqual({ url: "https://auth0.com/fs", domain: "auth0.com", title: "Auth0", snippet: "Yes" });
    expect(r.aiOverview).toEqual({ triggered: false, text: null, references: [] });
  });
});

describe("DataForSEO locations", () => {
  it("derives Google location codes from ISO 3166 numeric codes", () => {
    expect(locationCode("us")).toEqual({ code: 2840, fallback: false });
    expect(locationCode("GB")).toEqual({ code: 2826, fallback: false });
    expect(locationCode("uk")).toEqual({ code: 2826, fallback: false });
    expect(locationCode("jp")).toEqual({ code: 2392, fallback: false });
    expect(locationCode("br")).toEqual({ code: 2076, fallback: false });
    expect(locationCode("de")).toEqual({ code: 2276, fallback: false });
  });

  it("falls back to the US for an unknown country instead of throwing, and says so in the snapshot", async () => {
    expect(locationCode("zz")).toEqual({ code: 2840, fallback: true });
    const bodies: unknown[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body))[0]);
      signals.push(init?.signal);
      return new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.002, result: [{ keyword: "x", items: [] }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const dfs = dataForSeoProvider({ login: "l", password: "p", fetchImpl });
    const r = await dfs.serp({ query: "x", locale: { country: "zz", language: "en" }, device: "desktop" });
    expect(bodies[0]).toMatchObject({ location_code: 2840, language_code: "en" });
    expect(r.raw).toMatchObject({ localeFallback: { requested: "zz", locationCode: 2840 } });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const known = await dfs.serp({ query: "x", locale: { country: "jp", language: "ja" }, device: "desktop" });
    expect(bodies[1]).toMatchObject({ location_code: 2392 });
    expect(known.raw).not.toHaveProperty("localeFallback");
  });
});

describe("vendor deadlines", () => {
  it("every vendor call carries a deadline, and a timed-out call is not retried in-process", async () => {
    expect(DATAFORSEO_TIMEOUTS_MS).toEqual({ serp: 90_000, autocomplete: 30_000 });
    expect(SERPAPI_TIMEOUT_MS).toBe(60_000);
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(retryUnlessTimedOut(timeout)).toBe(false);
    expect(retryUnlessTimedOut(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);

    let calls = 0;
    const timingOut = (async () => {
      calls += 1;
      throw timeout;
    }) as unknown as typeof fetch;
    await expect(serpApiProvider({ apiKey: "k", fetchImpl: timingOut }).serp({ query: "x", locale: { country: "us", language: "en" }, device: "desktop" })).rejects.toThrow(/timeout/);
    expect(calls).toBe(1);
    const seen: (AbortSignal | null | undefined)[] = [];
    const ok = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await serpApiProvider({ apiKey: "k", fetchImpl: ok }).serp({ query: "x", locale: { country: "us", language: "en" }, device: "desktop" });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});
