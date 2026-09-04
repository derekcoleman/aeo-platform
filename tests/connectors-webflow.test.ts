import { describe, expect, it } from "vitest";
import { WebflowApi, WebflowApiError, articleFieldData, suggestFieldMap, type WebflowField } from "@/lib/connectors/webflow";
import { memorySecrets } from "@/lib/secrets/vault";
import { payloadHash, pushItemToTarget, webflowBodyHtml, type PublishTargetRow } from "@/lib/publishing/targets";
import { fakeSql } from "./helpers/fake-sql";

const f = (slug: string, type: string, displayName = slug, extra: Partial<WebflowField> = {}): WebflowField => ({ id: slug, slug, displayName, type, isRequired: false, isEditable: true, ...extra });

describe("suggestFieldMap", () => {
  it("picks body, summary, image, date and canonical fields by type and name", () => {
    const map = suggestFieldMap([f("name", "PlainText"), f("slug", "PlainText"), f("post-summary", "PlainText", "Post Summary"), f("post-body", "RichText", "Post Body"), f("main-image", "Image", "Main Image"), f("published-on", "DateTime", "Published On"), f("canonical-url", "PlainText", "Canonical URL"), f("author", "PlainText")]);
    expect(map).toEqual({ name: "name", slug: "slug", body: "post-body", summary: "post-summary", image: "main-image", publishedAt: "published-on", canonical: "canonical-url", author: "author" });
  });
  it("falls back to the first rich text field and leaves optional slots empty", () => {
    const map = suggestFieldMap([f("name", "PlainText"), f("slug", "PlainText"), f("content", "RichText")]);
    expect(map.body).toBe("content");
    expect(map.summary).toBeNull();
    expect(map.image).toBeNull();
  });
});

describe("articleFieldData", () => {
  const article = { title: "SSO vs SCIM", slug: "SSO vs SCIM!", bodyHtml: "<p>hi</p>", summary: "s", publishedAt: new Date("2026-09-04T00:00:00Z"), canonicalUrl: "https://acme.com/resources/sso-vs-scim", authorName: "Jane" };
  it("maps only the configured slots and writes the canonical only in proxy mode", () => {
    const map = { name: "name", slug: "slug", body: "post-body", summary: "post-summary", canonical: "canonical-url", author: "author", publishedAt: "published-on", image: "main-image" };
    const data = articleFieldData(article, map, { canonicalMode: "proxy" });
    expect(data).toMatchObject({ name: "SSO vs SCIM", slug: "sso-vs-scim", "post-body": "<p>hi</p>", "post-summary": "s", "canonical-url": article.canonicalUrl, author: "Jane", "published-on": "2026-09-04T00:00:00.000Z" });
    expect(data).not.toHaveProperty("main-image");
    expect(articleFieldData(article, map, { canonicalMode: "webflow" })).not.toHaveProperty("canonical-url");
  });
  it("refuses a map without a body field", () => {
    expect(() => articleFieldData(article, { name: "name", slug: "slug", body: "" }, { canonicalMode: "none" })).toThrow(/body/);
  });
});

function fakeWebflow() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const items = new Map<string, Record<string, unknown>>();
  let n = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.webflow.com/v2", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (path === "/sites") return json({ sites: [{ id: "site1", displayName: "Acme", shortName: "acme", customDomains: [{ url: "acme.com" }] }] });
    if (path === "/sites/site1/collections") return json({ collections: [{ id: "col1", displayName: "Blog Posts", slug: "blog" }] });
    if (path === "/collections/col1") return json({ id: "col1", displayName: "Blog Posts", slug: "blog", fields: [{ id: "1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }, { id: "2", slug: "slug", displayName: "Slug", type: "PlainText" }, { id: "3", slug: "post-body", displayName: "Post Body", type: "RichText" }] });
    if (method === "POST" && path === "/collections/col1/items") {
      const id = `item${++n}`;
      items.set(id, body.fieldData);
      return json({ id, isDraft: body.isDraft, isArchived: false, fieldData: body.fieldData }, 202);
    }
    if (method === "PATCH" && path.startsWith("/collections/col1/items/")) {
      const id = path.split("/").pop()!;
      if (!items.has(id)) return json({ message: "Item not found", code: "not_found" }, 404);
      items.set(id, body.fieldData);
      return json({ id, isDraft: body.isDraft ?? false, isArchived: false, fieldData: body.fieldData });
    }
    if (method === "POST" && path === "/collections/col1/items/publish") return json({ publishedItemIds: body.itemIds });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({ message: "no route" }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, items };
}

describe("WebflowApi", () => {
  it("lists sites, collections and fields; creates, updates and publishes items", async () => {
    const wf = fakeWebflow();
    const api = new WebflowApi("tok", wf.fetchImpl);
    expect((await api.sites())[0]).toMatchObject({ id: "site1", displayName: "Acme", customDomains: ["acme.com"] });
    expect((await api.collections("site1"))[0]!.slug).toBe("blog");
    const col = await api.collection("col1");
    expect(col.fields.map((x) => x.slug)).toEqual(["name", "slug", "post-body"]);
    const item = await api.createItem("col1", { fieldData: { name: "A", slug: "a", "post-body": "<p>a</p>" }, isDraft: false });
    expect(item.id).toBe("item1");
    await api.updateItem("col1", item.id, { fieldData: { name: "B", slug: "a", "post-body": "<p>b</p>" } });
    expect(wf.items.get("item1")).toMatchObject({ name: "B" });
    expect((await api.publishItems("col1", [item.id])).publishedItemIds).toEqual(["item1"]);
    await expect(api.updateItem("col1", "nope", { fieldData: {} })).rejects.toBeInstanceOf(WebflowApiError);
    expect(wf.calls.every((c) => c.path.startsWith("/"))).toBe(true);
  });
});

describe("pushItemToTarget", () => {
  const target: PublishTargetRow = {
    id: "tgt1", org_id: "o1", site_id: "s1", kind: "webflow", connection_id: "conn1", name: "Acme blog", enabled: true, created_at: "",
    config: { siteId: "site1", siteName: "Acme", collectionId: "col1", collectionName: "Blog Posts", fieldMap: { name: "name", slug: "slug", body: "post-body" }, publishLive: true, canonicalMode: "proxy", autoPush: true },
  };
  const article = { id: "ci1", site_id: "s1", slug: "sso-vs-scim", title: "SSO vs SCIM", description: "d", body_html: "<p>body</p>", frontmatter: { faq: [{ question: "Q?", answer: "A" }] }, published_at: new Date("2026-09-04T00:00:00Z"), canonical_url: "https://acme.com/resources/sso-vs-scim", author_name: null, version_id: "v1" };
  function ctxWith(fetchImpl: typeof fetch, existing: Record<string, unknown>[] = []) {
    const secrets = memorySecrets();
    const sql = fakeSql([
      [/from content\.content_items ci/, () => [article]],
      [/from context\.context_connections where id/, () => [{ id: "conn1", org_id: "o1", site_id: "s1", provider: "webflow", status: "active", enabled: true, config: {}, scope: [], secret_ref: "vault:conn1", external_account_id: null, external_account_name: null, last_synced_at: null, last_error: null }]],
      [/select id, external_id, payload_hash, status from content\.external_publications/, () => existing],
    ]);
    return { ctx: { sql, secrets, fetchImpl, now: () => new Date("2026-09-04T12:00:00Z"), env: {} as NodeJS.ProcessEnv }, sql, secrets };
  }
  it("creates the item, publishes it live and records the external id", async () => {
    const wf = fakeWebflow();
    const { ctx, sql, secrets } = ctxWith(wf.fetchImpl);
    await secrets.put("vault:conn1", "tok");
    const r = await pushItemToTarget("ci1", target, ctx);
    expect(r).toMatchObject({ ok: true, externalId: "item1" });
    expect(wf.items.get("item1")).toMatchObject({ name: "SSO vs SCIM", slug: "sso-vs-scim" });
    expect(String(wf.items.get("item1")!["post-body"])).toContain("Frequently asked questions");
    expect(wf.calls.some((c) => c.path === "/collections/col1/items/publish")).toBe(true);
    const rec = sql.queries.find((q) => q.text.startsWith("insert into content.external_publications"))!;
    expect(rec.text).toContain("'published'");
    expect(rec.values).toContain("item1");
  });
  it("updates in place when an external id exists and skips an unchanged payload", async () => {
    const wf = fakeWebflow();
    wf.items.set("item7", {});
    const body = webflowBodyHtml({ body_html: article.body_html, faq: article.frontmatter.faq });
    const hash = payloadHash({ name: "SSO vs SCIM", slug: "sso-vs-scim", "post-body": body });
    const { ctx, secrets } = ctxWith(wf.fetchImpl, [{ id: "e1", external_id: "item7", payload_hash: hash, status: "published" }]);
    await secrets.put("vault:conn1", "tok");
    expect(await pushItemToTarget("ci1", target, ctx)).toMatchObject({ ok: true, skipped: "unchanged", externalId: "item7" });
    const forced = await pushItemToTarget("ci1", target, ctx, { force: true });
    expect(forced).toMatchObject({ ok: true, externalId: "item7" });
    expect(wf.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(wf.calls.filter((c) => c.method === "POST" && c.path === "/collections/col1/items")).toHaveLength(0);
  });
  it("records a failure row when Webflow rejects the item", async () => {
    const failing = (async () => new Response(JSON.stringify({ message: "Validation Error", code: "validation_error", details: [{ param: "fieldData.name" }] }), { status: 400 })) as typeof fetch;
    const { ctx, sql, secrets } = ctxWith(failing);
    await secrets.put("vault:conn1", "tok");
    const r = await pushItemToTarget("ci1", target, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Validation Error");
    expect(sql.queries.some((q) => q.text.includes("'failed'"))).toBe(true);
  });
});
