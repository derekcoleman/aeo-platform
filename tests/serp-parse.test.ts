import { describe, expect, it } from "vitest";
import { parseDataForSeoAutocomplete, parseDataForSeoSerp } from "@/lib/serp/dataforseo";
import { parseSerpApiAiOverview, parseSerpApiSerp, type SaSearch } from "@/lib/serp/serpapi";
import { domainOf } from "@/lib/serp/types";

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
