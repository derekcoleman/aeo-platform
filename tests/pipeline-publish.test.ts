import { describe, expect, it } from "vitest";
import { composeVersion } from "@/lib/pipeline/compose";
import { buildPublishedPage, pagePath, publishVersion, type PublishInputs } from "@/lib/pipeline/publish";
import { fakeSql } from "./helpers/fake-sql";
import { author, brief, draft, gartnerSource, site, SITE_ID } from "./fixtures/pipeline";

const when = new Date("2026-09-01T09:00:00.000Z");

function inputs(overrides: Partial<PublishInputs> = {}): PublishInputs {
  return {
    site,
    organization: { name: "Acme", url: "https://acme.com" },
    slug: "sso-vs-scim",
    title: "SSO vs SCIM",
    description: "Two halves of identity.",
    bodyHtml: "<p>SSO signs people in.</p>",
    bodyMd: "SSO signs people in.",
    author,
    citations: [{ url: gartnerSource.url, publisher: "Gartner", title: gartnerSource.title ?? null }],
    faq: [],
    datePublished: when,
    ...overrides,
  };
}

describe("pagePath", () => {
  it("joins prefix and slug, honouring the site's trailing-slash policy", () => {
    expect(pagePath(site, "sso-vs-scim")).toBe("/resources/sso-vs-scim");
    expect(pagePath({ ...site, trailingSlash: "always" }, "sso-vs-scim")).toBe("/resources/sso-vs-scim/");
  });
});

describe("buildPublishedPage", () => {
  it("builds the path and canonical URL against the public host, never the edge", () => {
    const page = buildPublishedPage(inputs());
    expect(page.path).toBe("/resources/sso-vs-scim");
    expect(page.canonicalUrl).toBe("https://acme.com/resources/sso-vs-scim");
    expect(page.markdown.startsWith("# SSO vs SCIM\n\n")).toBe(true);
    expect(page.head.title).toBe("SSO vs SCIM");
    expect(page.head.author?.name).toBe("Dana Reyes");
    expect(JSON.stringify(page)).not.toContain("blogedge");
  });

  it("derives a stable etag from body + head, and changes it when either changes", () => {
    const a = buildPublishedPage(inputs());
    const b = buildPublishedPage(inputs());
    const c = buildPublishedPage(inputs({ bodyHtml: "<p>Different.</p>" }));
    const d = buildPublishedPage(inputs({ title: "Other title" }));
    expect(a.etag).toBe(b.etag);
    expect(a.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(c.etag).not.toBe(a.etag);
    expect(d.etag).not.toBe(a.etag);
  });

  it("refuses to build a page whose body or markdown carries the edge hostname", () => {
    expect(() => buildPublishedPage(inputs({ bodyHtml: `<a href="https://${site.edgeHostname}/x">x</a>` }))).toThrow(/edge hostname/i);
    expect(() => buildPublishedPage(inputs({ bodyMd: `see ${site.edgeHostname}` }))).toThrow(/edge hostname/i);
  });

  it("carries citations and FAQ into JSON-LD built from data, not prose", () => {
    const page = buildPublishedPage(inputs({ faq: [{ question: "Does SCIM require SSO?", answer: "Not strictly." }] }));
    const json = JSON.stringify(page.jsonLd);
    expect(json).toContain(gartnerSource.url);
    expect(json).toContain("FAQPage");
    expect(json).toContain("Does SCIM require SSO?");
  });
});

describe("composeVersion", () => {
  const composed = composeVersion({
    draft,
    brief,
    site,
    organization: { name: "Acme" },
    author,
    slug: "sso-vs-scim",
    datePublished: when,
  });

  it("keeps markers in the stored markdown and resolves them in the HTML", () => {
    expect(composed.bodyMd).toContain("{{src:gartner-2026}}");
    expect(composed.bodyMd).toContain("## Frequently asked questions");
    expect(composed.bodyHtml).not.toContain("{{src:");
    expect(composed.bodyHtml).toContain(`href="${gartnerSource.url}"`);
    expect(composed.bodyHtml).toContain("<sup>1</sup>");
    expect(composed.bodyHtml).toContain("<table>");
    expect(composed.unresolved).toEqual([]);
    expect(composed.cited.map((c) => c.key)).toEqual(["gartner-2026"]);
    expect(composed.wordCount).toBeGreaterThan(150);
  });

  it("strips markers from FAQ answers so JSON-LD carries plain text", () => {
    expect(composed.faq[1]!.answer).toBe("SCIM is the standard protocol most identity providers use for user provisioning; provisioning is the outcome, SCIM is how it is done.");
    expect(JSON.stringify(composed.page.jsonLd)).not.toContain("{{src:");
  });

  it("builds the page from the same bytes", () => {
    expect(composed.page.path).toBe("/resources/sso-vs-scim");
    expect(composed.page.html).toBe(composed.bodyHtml);
    expect(composed.page.head.title).toBe(draft.title);
  });
});

describe("publishVersion", () => {
  it("upserts published_pages and flips the content item inside one transaction", async () => {
    const page = buildPublishedPage(inputs());
    let began = 0;
    const sql = fakeSql();
    const origin = sql.begin as unknown as (fn: (s: typeof sql) => Promise<unknown>) => Promise<unknown>;
    (sql as { begin: unknown }).begin = async (fn: (s: typeof sql) => Promise<unknown>) => {
      began++;
      return origin(fn);
    };

    const result = await publishVersion({ contentItemId: "item-1", versionId: "ver-1", siteId: SITE_ID, page, now: when }, sql);

    expect(began).toBe(1);
    expect(result).toEqual({ path: "/resources/sso-vs-scim", canonicalUrl: "https://acme.com/resources/sso-vs-scim", etag: page.etag });
    const [upsert, flip] = sql.queries;
    expect(upsert!.text).toMatch(/^insert into content\.published_pages .* on conflict \(site_id, path\) do update/);
    expect(upsert!.values.slice(0, 4)).toEqual([SITE_ID, "/resources/sso-vs-scim", "item-1", page.html]);
    expect(upsert!.values[6]).toBe(page.etag);
    expect(flip!.text).toMatch(/^update content\.content_items set status = 'published'/);
    expect(flip!.values).toEqual(["SSO vs SCIM", "ver-1", "https://acme.com/resources/sso-vs-scim", when, when, when, "item-1"]);
  });
});
