import { describe, expect, it } from "vitest";
import { existingContentBlock, briefPrompt, type BriefContext } from "@/lib/pipeline/briefs";
import { draftPrompt } from "@/lib/pipeline/draft";
import { existingContentFromCms, importCmsItem, loadExistingContent, publishRefreshToCms, refreshFieldData, type CmsItemRow } from "@/lib/refresh/publish";
import { memorySecrets } from "@/lib/secrets/vault";
import { fakeSql } from "./helpers/fake-sql";
import { composeVersion } from "@/lib/pipeline/compose";
import { FAQ_HEADING, faqSectionCount } from "@/lib/pipeline/markdown";
import { author, brief, draft, site } from "./fixtures/pipeline";

const cms: CmsItemRow = {
  id: "cms1",
  org_id: "o1",
  site_id: "s1",
  connection_id: "conn1",
  collection_id: "col1",
  collection_name: "Blog Posts",
  external_id: "item7",
  slug: "sso-vs-scim",
  title: "SSO vs SCIM",
  url: "https://acme.com/blog/sso-vs-scim",
  body_html: "<h2>What is SSO?</h2><p>SSO signs people in once.</p><p>62% of buyers want SCIM.</p>",
  summary: "Old summary",
  word_count: 12,
  is_draft: false,
  is_archived: false,
  last_updated: new Date("2025-06-01T00:00:00Z"),
  last_published: new Date("2025-06-02T00:00:00Z"),
  field_map: { name: "name", slug: "slug", body: "post-body", summary: "post-summary" },
  content_item_id: "ci1",
  refresh_reasons: ["Not updated in 15 months", "Search demand but no AI citations"],
};

describe("existing content for the prompts", () => {
  it("turns the CMS body into markdown and carries the reasons", () => {
    const e = existingContentFromCms(cms);
    expect(e).toMatchObject({ title: "SSO vs SCIM", url: cms.url, description: "Old summary", wordCount: 12, lastUpdated: "2025-06-01", reasons: cms.refresh_reasons });
    expect(e.bodyMd).toContain("## What is SSO?");
    expect(e.bodyMd).not.toContain("<h2>");
  });

  it("loads from the evidence's cms item, else the linked item, else our own current version", async () => {
    const sqlCms = fakeSql([[/from content\.cms_items where id/, () => [cms]]]);
    expect((await loadExistingContent({ content_item_id: null, evidence: { cmsItemId: "cms1" } }, sqlCms))?.title).toBe("SSO vs SCIM");
    const sqlLinked = fakeSql([[/from content\.cms_items where content_item_id/, () => [cms]]]);
    expect((await loadExistingContent({ content_item_id: "ci1", evidence: {} }, sqlLinked))?.url).toBe(cms.url);
    const sqlOwn = fakeSql([[/join content\.content_versions v on v\.id = ci\.current_version_id/, () => [{ title: "Ours", description: "d", body_md: "Body {{src:gartner-2026}} here {{fact:x-1}}.", word_count: 3, canonical_url: "https://acme.com/resources/ours", published_at: new Date("2026-01-01T00:00:00Z") }]]]);
    const own = await loadExistingContent({ content_item_id: "ci9", evidence: { reasons: ["window 30d"] } }, sqlOwn);
    expect(own).toMatchObject({ title: "Ours", url: "https://acme.com/resources/ours", bodyMd: "Body  here .", lastUpdated: "2026-01-01", reasons: ["window 30d"] });
    expect(await loadExistingContent({ content_item_id: null, evidence: {} }, fakeSql())).toBeNull();
  });

  it("puts the refresh rules and the current article into the brief and the draft prompts", () => {
    const e = existingContentFromCms(cms);
    const block = existingContentBlock(e);
    expect(block).toMatch(/THIS IS A REFRESH .* https:\/\/acme\.com\/blog\/sso-vs-scim \(last updated 2025-06-01\), 12 words/);
    expect(block).toContain("- Not updated in 15 months");
    expect(block).toContain("## What is SSO?");
    const ctx: BriefContext = { opportunity: { title: "Refresh: SSO vs SCIM", targetQuery: "SSO vs SCIM", source: "refresh", evidence: {} }, site: { domain: "acme.com", pathPrefix: "/resources", organizationName: "Acme" }, relatedQuestions: [], existingPages: [], existingContent: e };
    expect(briefPrompt(ctx)).toContain("THIS IS A REFRESH");
    expect(briefPrompt({ ...ctx, existingContent: null })).not.toContain("THIS IS A REFRESH");
    const dp = draftPrompt({ brief, author: { name: "Dana" }, site: { organizationName: "Acme", domain: "acme.com" }, previous: { title: e.title, description: "d", bodyMd: e.bodyMd, faq: [] }, refresh: { url: e.url, lastUpdated: e.lastUpdated, reasons: e.reasons } });
    expect(dp).toContain("This is a REFRESH of an article that is already live at https://acme.com/blog/sso-vs-scim");
    expect(dp).toContain("Current live article (revise it; keep what works)");
    expect(dp).toContain("- Search demand but no AI citations");
    expect(draftPrompt({ brief, author: { name: "Dana" }, site: { organizationName: "Acme", domain: "acme.com" }, previous: { title: "t", description: "d", bodyMd: "b", faq: [] } })).toContain("Previous draft (revise it; keep what works)");
  });

  it("hands a refresh of our own article its FAQ as entries, never as a section of the body", async () => {
    // What the first publish stored: body_md ends in the FAQ section composeVersion appended.
    const first = composeVersion({ draft, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: new Date("2026-08-01T00:00:00Z") });
    const sql = fakeSql([[/join content\.content_versions v on v\.id = ci\.current_version_id/, () => [{ title: draft.title, description: draft.description, body_md: first.bodyMd, frontmatter: { faq: first.faq }, word_count: first.wordCount, canonical_url: first.page.canonicalUrl, published_at: null }]]]);
    const existing = (await loadExistingContent({ content_item_id: "ci1", evidence: {} }, sql))!;
    expect(existing.bodyMd).not.toContain(FAQ_HEADING);
    expect(existing.bodyMd).not.toMatch(/\{\{/);
    expect(existing.faq).toEqual(first.faq);
    expect(sql.queries.at(-1)!.text).toContain("v.frontmatter");

    // A refresh that keeps the live body as it is and answers the same FAQ prints the FAQ once.
    const refreshed = composeVersion({ draft: { title: existing.title, description: draft.description, bodyMd: existing.bodyMd, faq: existing.faq }, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: new Date("2026-09-01T00:00:00Z") });
    expect(faqSectionCount(refreshed.bodyMd)).toBe(1);
    expect(existingContentBlock(existing)).toContain(`Current FAQ:\n- ${first.faq[0]!.question}`);
  });

  it("cuts the FAQ section a past push left in a CMS body out into entries", () => {
    const e = existingContentFromCms({ ...cms, body_html: `${cms.body_html}<h2>Frequently asked questions</h2><h3>Does SCIM need SSO?</h3><p>No.</p>` });
    expect(e.bodyMd).toContain("## What is SSO?");
    expect(e.bodyMd).not.toContain("Frequently asked questions");
    expect(e.faq).toEqual([{ question: "Does SCIM need SSO?", answer: "No." }]);
    expect(existingContentFromCms(cms).faq).toEqual([]);
  });
});

describe("importCmsItem", () => {
  it("creates a cms-origin content item once and links it back", async () => {
    let created = 0;
    const sql = fakeSql([
      [/from content\.cms_items where id/, () => [{ ...cms, content_item_id: null }]],
      [/^select slug from content\.content_items where site_id/, () => [{ slug: "sso-vs-scim" }]],
      [/^insert into content\.content_items/, () => [{ id: `new${++created}` }]],
    ]);
    const r = await importCmsItem("cms1", { opportunityId: "opp1", authorId: "a1" }, sql);
    expect(r).toEqual({ id: "new1", slug: "sso-vs-scim-2", imported: true });
    const insert = sql.queries.find((q) => q.text.startsWith("insert into content.content_items"))!;
    expect(insert.values).toContain("cms");
    expect(sql.queries.some((q) => q.text.startsWith("update content.cms_items set content_item_id"))).toBe(true);

    const linked = fakeSql([
      [/from content\.cms_items where id/, () => [cms]],
      [/^select id, slug from content\.content_items where id/, () => [{ id: "ci1", slug: "sso-vs-scim" }]],
    ]);
    expect(await importCmsItem("cms1", { opportunityId: null, authorId: null }, linked)).toEqual({ id: "ci1", slug: "sso-vs-scim", imported: false });
    expect(linked.queries.some((q) => q.text.startsWith("insert into"))).toBe(false);
  });
});

describe("refreshFieldData", () => {
  it("writes title, body (with FAQ) and summary through the map and never the slug", () => {
    const data = refreshFieldData(cms, { title: "SSO vs SCIM (2026)", description: "New summary", bodyHtml: "<p>new</p>", faq: [{ question: "Q?", answer: "A." }] });
    expect(data).toEqual({ name: "SSO vs SCIM (2026)", "post-body": "<p>new</p><h2>Frequently asked questions</h2><h3>Q?</h3><p>A.</p>", "post-summary": "New summary" });
    expect(data).not.toHaveProperty("slug");
    expect(() => refreshFieldData({ field_map: { name: "name", slug: "slug", body: "" } }, { title: "t", description: null, bodyHtml: "<p>x</p>", faq: [] })).toThrow(/rich-text body/);
  });
});

function fakeWebflow() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.webflow.com/v2", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (method === "PATCH" && path === "/collections/col1/items/item7") return json({ id: "item7", isDraft: body.isDraft ?? false, isArchived: false, fieldData: body.fieldData });
    if (method === "POST" && path === "/collections/col1/items/publish") return json({ publishedItemIds: body.itemIds });
    return json({ message: "no route" }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("publishRefreshToCms", () => {
  const version = { title: "SSO vs SCIM (2026)", description: "New summary", body_html: "<p>new body</p>", frontmatter: { faq: [] } };
  const conn = { id: "conn1", org_id: "o1", site_id: "s1", provider: "webflow", status: "active", enabled: true, config: {}, scope: [], secret_ref: "vault:conn1", external_account_id: null, external_account_name: null, last_synced_at: null, last_error: null };
  async function run(item: CmsItemRow, stored: typeof version = version) {
    const wf = fakeWebflow();
    const secrets = memorySecrets();
    await secrets.put("vault:conn1", "tok");
    const sql = fakeSql([
      [/from content\.cms_items where content_item_id/, () => [item]],
      [/from content\.content_versions where id/, () => [stored]],
      [/from context\.context_connections where id/, () => [conn]],
    ]);
    const r = await publishRefreshToCms({ contentItemId: "ci1", versionId: "v2", now: new Date("2026-09-15T12:00:00Z") }, { sql, secrets, fetchImpl: wf.fetchImpl, now: () => new Date("2026-09-15T12:00:00Z"), env: {} as NodeJS.ProcessEnv });
    return { r, wf, sql };
  }

  it("PATCHes the same item with the new body, keeps it live, and records the publish", async () => {
    const { r, wf, sql } = await run(cms);
    expect(r).toEqual({ ok: true, externalId: "item7", url: cms.url, publishedLive: true });
    const patch = wf.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ isDraft: false, fieldData: { name: "SSO vs SCIM (2026)", "post-body": "<p>new body</p>", "post-summary": "New summary" } });
    expect(wf.calls.some((c) => c.path === "/collections/col1/items/publish")).toBe(true);
    expect(wf.calls.filter((c) => c.method === "POST" && c.path === "/collections/col1/items")).toHaveLength(0);
    const flip = sql.queries.find((q) => q.text.startsWith("update content.content_items set status = 'published'"))!;
    expect(flip.values).toContain(cms.url);
    expect(sql.queries.some((q) => q.text.startsWith("update content.cms_items set title"))).toBe(true);
    expect(sql.queries.some((q) => q.text.startsWith("insert into content.external_publications"))).toBe(true);
    expect(sql.queries.some((q) => q.text.startsWith("insert into content.published_pages"))).toBe(false);
  });

  it("sends the HTML QA scored, its FAQ printed once", async () => {
    // What the draft step composed and insertVersion stored: the body already ends in its FAQ.
    const drafted = composeVersion({ draft, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: new Date("2026-09-14T12:00:00Z") });
    const { wf } = await run(cms, { ...version, body_html: drafted.bodyHtml, frontmatter: { faq: drafted.faq as never[] } });
    const body = String((wf.calls.find((c) => c.method === "PATCH")!.body as { fieldData: Record<string, unknown> }).fieldData["post-body"]);
    expect(body).toBe(drafted.bodyHtml);
    expect(body.match(/Frequently asked questions/g)).toHaveLength(1);
  });

  it("leaves a staged post staged", async () => {
    const { r, wf } = await run({ ...cms, last_published: null });
    expect(r.publishedLive).toBe(false);
    expect((wf.calls.find((c) => c.method === "PATCH")!.body as { isDraft: boolean }).isDraft).toBe(true);
    expect(wf.calls.some((c) => c.path === "/collections/col1/items/publish")).toBe(false);
  });
});
