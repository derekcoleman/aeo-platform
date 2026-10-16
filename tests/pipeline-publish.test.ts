import { describe, expect, it } from "vitest";
import { composeVersion } from "@/lib/pipeline/compose";
import { buildPublishedPage, pagePath, publishVersion, type PublishInputs } from "@/lib/pipeline/publish";
import { FAQ_HEADING, recomposeFromVersion, remediateDuplicateFaq, sitesWithDuplicateFaq } from "@/lib/pipeline/republish";
import { fakeSql, type FakeSqlHandler } from "./helpers/fake-sql";
import { author, brief, draft, gartnerSource, ORG_ID, site, SITE_ID } from "./fixtures/pipeline";

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

const headings = (md: string) => md.split(FAQ_HEADING).length - 1;

describe("publishing a stored version", () => {
  // What the draft step composed, QA scored and insertVersion stored.
  const drafted = composeVersion({ draft, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: when });
  const stored = {
    id: "ver-1",
    org_id: ORG_ID,
    content_item_id: "item-1",
    version_no: 1,
    title: draft.title,
    description: draft.description,
    body_md: drafted.bodyMd,
    body_html: drafted.bodyHtml,
    frontmatter: { intent: brief.intent, faq: drafted.faq, briefId: "brief-1", attempt: 1 },
    schema_jsonld: null,
    word_count: drafted.wordCount,
  };
  const later = new Date("2026-09-03T10:00:00.000Z");

  function db(overrides: { item?: Record<string, unknown>; pages?: Record<string, unknown>[]; handlers?: [RegExp, FakeSqlHandler][] } = {}) {
    return fakeSql([
      ...(overrides.handlers ?? []),
      [/from content\.content_versions/, () => [stored]],
      [/from content\.content_items where id/, () => [{ site_id: SITE_ID, slug: "sso-vs-scim", author_id: author.id, first_published_at: null, ...overrides.item }]],
      [/from app\.sites where id/, () => [{ id: SITE_ID, org_id: ORG_ID, canonical_domain: "acme.com", path_prefix: "/resources", edge_hostname: site.edgeHostname, proxy_mode: "cloudflare_worker", trailing_slash: "never", locale: "en-US", status: "active" }]],
      [/from content\.site_render_config/, () => [{ organization: { name: "Acme" } }]],
      [/from content\.content_sources/, () => drafted.cited],
      [/from content\.authors where id/, () => [author]],
      [/from content\.published_pages p/, () => overrides.pages ?? []],
      [/^update content\.published_pages/, (q) => [{ path: q.values[q.values.length - 2] }]],
    ]);
  }

  it("recomposes to the bytes QA scored, with the FAQ printed once", () => {
    expect(headings(drafted.bodyMd)).toBe(1);
    const input = {
      draft: { title: stored.title, description: stored.description, bodyMd: stored.body_md, faq: stored.frontmatter.faq },
      brief: { sources: drafted.cited, intent: brief.intent },
      site,
      organization: { name: "Acme" },
      author,
      slug: "sso-vs-scim",
      datePublished: when,
      dateModified: later,
    };
    const recomposed = composeVersion({ ...input, faqIncluded: true });
    expect(recomposed.bodyHtml).toBe(drafted.bodyHtml);
    expect(recomposed.bodyMd).toBe(drafted.bodyMd);
    expect(headings(recomposed.page.markdown)).toBe(1);
    // The old publish path appended the stored FAQ a second time.
    expect(headings(composeVersion(input).page.markdown)).toBe(2);
  });

  it("recomposeFromVersion publishes the stored version's HTML byte for byte", async () => {
    const sql = db();
    const result = await recomposeFromVersion({ contentItemId: "item-1", versionId: "ver-1", siteId: SITE_ID, now: later }, sql);
    expect(result.path).toBe("/resources/sso-vs-scim");
    const upsert = sql.queries.find((q) => q.text.startsWith("insert into content.published_pages"))!;
    expect(upsert.values[3]).toBe(drafted.bodyHtml);
    const head = (upsert.values[4] as { __json: { datePublished: string; dateModified: string; author: { name: string } } }).__json;
    // First publish: published = modified = now; the byline is the item's author.
    expect(head).toMatchObject({ datePublished: later.toISOString(), dateModified: later.toISOString(), author: { name: author.name } });
    expect(headings(upsert.values[5] as string)).toBe(1);
    const flip = sql.queries.find((q) => q.text.startsWith("update content.content_items"))!;
    expect(flip.values).toContain("ver-1");
  });

  it("keeps the original publish date on a republish", async () => {
    const sql = db({ item: { first_published_at: when } });
    await recomposeFromVersion({ contentItemId: "item-1", versionId: "ver-1", siteId: SITE_ID, now: later }, sql);
    const upsert = sql.queries.find((q) => q.text.startsWith("insert into content.published_pages"))!;
    expect((upsert.values[4] as { __json: { datePublished: string } }).__json.datePublished).toBe(when.toISOString());
  });

  it("refuses ids that do not belong together", async () => {
    await expect(recomposeFromVersion({ contentItemId: "item-2", versionId: "ver-1", siteId: SITE_ID }, db())).rejects.toThrow(/another content item/);
    await expect(recomposeFromVersion({ contentItemId: "item-1", versionId: "ver-1", siteId: "other-site" }, db())).rejects.toThrow(/not on site/);
  });

  it("remediateDuplicateFaq rewrites only the page row, keeps its visible date, and audits the paths", async () => {
    const shown = "2026-09-02T08:00:00.000Z";
    const sql = db({
      pages: [
        { site_id: SITE_ID, org_id: ORG_ID, path: "/resources/sso-vs-scim", content_item_id: "item-1", version_id: "ver-1", etag: "etag-1", head: { dateModified: shown } },
        { site_id: SITE_ID, org_id: ORG_ID, path: "/blog/sso-vs-scim", content_item_id: "item-1", version_id: "ver-1", etag: "etag-2", head: {} },
      ],
    });
    const out = await remediateDuplicateFaq(SITE_ID, { actorUserId: "staff-1", now: later }, sql);

    expect(out).toEqual([{ siteId: SITE_ID, orgId: ORG_ID, paths: ["/resources/sso-vs-scim"], skipped: [{ path: "/blog/sso-vs-scim", reason: "recomposed path is /resources/sso-vs-scim" }], repush: [] }]);
    const select = sql.queries.find((q) => q.text.includes("from content.published_pages p"))!;
    expect(select.values).toEqual([SITE_ID, SITE_ID, `%${FAQ_HEADING}%${FAQ_HEADING}%`]);
    const update = sql.queries.find((q) => q.text.startsWith("update content.published_pages"))!;
    expect(update.values[0]).toBe(drafted.bodyHtml);
    expect((update.values[1] as { __json: { dateModified: string } }).__json.dateModified).toBe(shown);
    expect(headings(update.values[2] as string)).toBe(1);
    // Only the row that was read: a page republished since has another etag.
    expect(update.text).toContain("and etag = $");
    expect(update.values.at(-1)).toBe("etag-1");
    // Publish dates on the item drive attribution windows; a formatting fix must not move them.
    expect(sql.queries.some((q) => q.text.startsWith("update content.content_items"))).toBe(false);
    const audit = sql.queries.find((q) => q.text.startsWith("insert into app.audit_log"))!;
    expect(audit.text).toContain("'content.remediate_faq'");
    expect(audit.values).toEqual([ORG_ID, "staff-1", SITE_ID, { __json: { paths: ["/resources/sso-vs-scim"], skipped: [{ path: "/blog/sso-vs-scim", reason: "recomposed path is /resources/sso-vs-scim" }], repush: [] } }]);
  });

  it("remediateDuplicateFaq leaves a page that was republished since it was selected", async () => {
    const sql = db({
      pages: [{ site_id: SITE_ID, org_id: ORG_ID, path: "/resources/sso-vs-scim", content_item_id: "item-1", version_id: "ver-1", etag: "etag-old", head: {} }],
      // The page row no longer holds etag-old: a newer version went live between the select and the update.
      handlers: [[/^update content\.published_pages/, () => []]],
    });
    const [out] = await remediateDuplicateFaq(SITE_ID, { actorUserId: "staff-1", now: later }, sql);
    expect(out).toMatchObject({ paths: [], skipped: [{ path: "/resources/sso-vs-scim", reason: "changed since selected" }] });
  });

  it("remediateDuplicateFaq skips, and reports, a version whose own body carries the FAQ twice", async () => {
    const doubled = { ...stored, body_md: `${drafted.bodyMd}\n\n${drafted.bodyMd.slice(drafted.bodyMd.indexOf(FAQ_HEADING))}` };
    const sql = db({
      pages: [{ site_id: SITE_ID, org_id: ORG_ID, path: "/resources/sso-vs-scim", content_item_id: "item-1", version_id: "ver-1", etag: "etag-1", head: {} }],
      handlers: [[/from content\.content_versions/, () => [doubled]]],
    });
    const [out] = await remediateDuplicateFaq(SITE_ID, { actorUserId: "staff-1", now: later }, sql);
    expect(out).toMatchObject({ paths: [], skipped: [{ path: "/resources/sso-vs-scim", reason: expect.stringMatching(/carries the FAQ twice/) }] });
    expect(sql.queries.some((q) => q.text.startsWith("update content.published_pages"))).toBe(false);
  });

  it("remediateDuplicateFaq queues the site's Webflow copies of the same version for a re-push, and audits them", async () => {
    const sql = db({
      pages: [{ site_id: SITE_ID, org_id: ORG_ID, path: "/resources/sso-vs-scim", content_item_id: "item-1", version_id: "ver-1", etag: "etag-1", head: {} }],
      handlers: [[/from content\.external_publications e/, () => [{ content_item_id: "item-1", target_id: "target-1" }]]],
    });
    const [out] = await remediateDuplicateFaq(SITE_ID, { actorUserId: "staff-1", now: later }, sql);
    expect(out!.repush).toEqual([{ contentItemId: "item-1", targetId: "target-1" }]);
    const select = sql.queries.find((q) => q.text.includes("from content.external_publications e"))!;
    expect(select.values).toEqual([SITE_ID]);
    // Same version only (never a newer one to a hand-published target), pipeline items with an FAQ, enabled Webflow targets.
    for (const clause of ["e.version_id = i.current_version_id", "i.origin = 'pipeline'", "t.enabled and t.kind = 'webflow'", "e.status = 'published'", "v.frontmatter->'faq'"]) expect(select.text).toContain(clause);
    const audit = sql.queries.find((q) => q.text.startsWith("insert into app.audit_log"))!;
    expect((audit.values[3] as { __json: { repush: unknown[] } }).__json.repush).toEqual([{ contentItemId: "item-1", targetId: "target-1" }]);
  });

  it("remediateDuplicateFaq audits the pages it rewrote even when a later one throws", async () => {
    const page = (path: string) => ({ site_id: SITE_ID, org_id: ORG_ID, path, content_item_id: "item-1", version_id: "ver-1", etag: "etag-1", head: {} });
    let updates = 0;
    const sql = db({
      pages: [page("/resources/sso-vs-scim"), page("/resources/sso-vs-scim")],
      handlers: [
        [
          /^update content\.published_pages/,
          () => {
            if (++updates === 2) throw new Error("connection reset");
            return [{ path: "/resources/sso-vs-scim" }];
          },
        ],
      ],
    });

    await expect(remediateDuplicateFaq(SITE_ID, { actorUserId: "staff-1", now: later }, sql)).rejects.toThrow(/connection reset/);
    const audit = sql.queries.find((q) => q.text.startsWith("insert into app.audit_log"))!;
    expect(audit.values).toEqual([ORG_ID, "staff-1", SITE_ID, { __json: { paths: ["/resources/sso-vs-scim"], skipped: [], repush: [] } }]);
  });

  it("sitesWithDuplicateFaq lists the affected sites, so the job can fix and audit one site per step", async () => {
    const sql = fakeSql([[/select distinct p\.site_id/, () => [{ site_id: SITE_ID }]]]);
    expect(await sitesWithDuplicateFaq(null, sql)).toEqual([SITE_ID]);
    expect(sql.queries[0]!.values).toEqual([null, null, `%${FAQ_HEADING}%${FAQ_HEADING}%`]);
    expect(sql.queries[0]!.text).toContain("i.origin = 'pipeline'");
  });

  it("remediateDuplicateFaq does nothing, and audits nothing, when no page is affected", async () => {
    const sql = db();
    expect(await remediateDuplicateFaq(null, {}, sql)).toEqual([]);
    expect(sql.queries.some((q) => q.text.startsWith("insert into app.audit_log"))).toBe(false);
  });
});
