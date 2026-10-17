import { describe, expect, it } from "vitest";
import type { ConnectorContext } from "@/lib/connectors";
import { setIndexingPaused } from "@/lib/app/store";
import { notifyOrg } from "@/lib/notify/org";
import { controlFor, setAutonomyControl, type AutonomyControl } from "@/lib/ops/controls";
import { composeVersion } from "@/lib/pipeline/compose";
import type { GateStep } from "@/lib/pipeline/gate";
import { guardVerdict, holdWhilePaused, isHeld, publishGuard, PUBLISH_HOLD, PUBLISH_MAX_HOLDS, type GuardState } from "@/lib/pipeline/guard";
import { isTakenDown, setPageStatus } from "@/lib/pipeline/publish";
import { rollbackPage, RollbackRefusedError } from "@/lib/pipeline/republish";
import { buildFeed, buildLlmsTxt, buildSitemap, listedPages, type PageSummary } from "@/lib/render/artifacts";
import { renderArticleDocument } from "@/lib/render/document";
import { toPublishedPage, type PublishedPageRow } from "@/lib/render/published";
import { articleHeaders } from "@/lib/render/routes";
import type { SiteRenderConfig } from "@/lib/render/site-config";
import { fakeFetch } from "./helpers/fake-fetch";
import { fakeSql, type FakeSqlHandler } from "./helpers/fake-sql";
import { author, brief, draft, ORG_ID, site, SITE_ID } from "./fixtures/pipeline";

const PATH = "/resources/sso-vs-scim";
const USER = "99999999-0000-0000-0000-000000000001";
const when = new Date("2026-10-01T09:00:00.000Z");

const auditOf = (sql: ReturnType<typeof fakeSql>) => sql.queries.filter((q) => q.text.startsWith("insert into app.audit_log"));

describe("setPageStatus", () => {
  const page = (status: "live" | "noindex" | "retired") => fakeSql([[/from content\.published_pages p join app\.sites s/, () => [{ org_id: ORG_ID, content_item_id: "item-1", status }]]]);

  it("takes a live page out of the index and audits who, what and why", async () => {
    const sql = page("live");
    const change = await setPageStatus(SITE_ID, PATH, "noindex", { by: USER, reason: "  outdated pricing  ", now: when }, sql);
    expect(change).toEqual({ siteId: SITE_ID, orgId: ORG_ID, path: PATH, contentItemId: "item-1", versionId: null, before: "live", after: "noindex", changed: true });
    const update = sql.queries.find((q) => q.text.startsWith("update content.published_pages"))!;
    expect(update.text).toContain("set status = $1, status_changed_at = $2, status_reason = $3");
    expect(update.values).toEqual(["noindex", when, "outdated pricing", SITE_ID, PATH]);
    const [audit] = auditOf(sql);
    expect(audit!.values).toEqual([ORG_ID, USER, "page.noindex", PATH, { __json: { siteId: SITE_ID, path: PATH, status: "live" } }, { __json: { siteId: SITE_ID, path: PATH, status: "noindex", reason: "outdated pricing" } }]);
  });

  it("retires and restores, clearing the reason on restore", async () => {
    const retire = page("noindex");
    await setPageStatus(SITE_ID, PATH, "retired", { by: USER, reason: "product discontinued" }, retire);
    expect(auditOf(retire)[0]!.values[2]).toBe("page.retired");

    const restore = page("retired");
    const change = await setPageStatus(SITE_ID, PATH, "live", { by: USER, reason: "back" }, restore);
    expect(change).toMatchObject({ before: "retired", after: "live", changed: true });
    expect(restore.queries.find((q) => q.text.startsWith("update content.published_pages"))!.values[2]).toBeNull();
    expect(auditOf(restore)[0]!.values[2]).toBe("page.live");
  });

  it("leaves a page already in that status alone, unaudited", async () => {
    const sql = page("retired");
    expect(await setPageStatus(SITE_ID, PATH, "retired", { by: USER }, sql)).toMatchObject({ changed: false });
    expect(sql.queries.some((q) => q.text.startsWith("update"))).toBe(false);
    expect(auditOf(sql)).toHaveLength(0);
  });

  it("returns null for a path the site has no page at", async () => {
    const sql = fakeSql();
    expect(await setPageStatus(SITE_ID, "/resources/nope", "retired", { by: USER }, sql)).toBeNull();
    expect(auditOf(sql)).toHaveLength(0);
  });

  it("isTakenDown is true only while the item's page is not live", async () => {
    expect(await isTakenDown("item-1", fakeSql([[/status <> 'live'/, () => [{ "?column?": 1 }]]]))).toBe(true);
    expect(await isTakenDown("item-1", fakeSql())).toBe(false);
  });
});

describe("rollbackPage", () => {
  const drafted = composeVersion({ draft, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: when });
  const previous = {
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

  function db(row: Record<string, unknown> | null, extra: [RegExp, FakeSqlHandler][] = []) {
    return fakeSql([
      ...extra,
      [/from content\.published_pages p\s+join app\.sites s/, () => (row ? [{ org_id: ORG_ID, content_item_id: "item-1", origin: "pipeline", version_id: "ver-2", previous_version_id: "ver-1", ...row }] : [])],
      [/from content\.content_versions where id/, (q) => (q.values[0] === "ver-1" ? [previous] : [])],
      [/from content\.content_items where id/, () => [{ site_id: SITE_ID, slug: "sso-vs-scim", author_id: author.id, first_published_at: when }]],
      [/from app\.sites where id/, () => [{ id: SITE_ID, org_id: ORG_ID, canonical_domain: "acme.com", path_prefix: "/resources", edge_hostname: site.edgeHostname, proxy_mode: "cloudflare_worker", trailing_slash: "never", locale: "en-US", status: "active" }]],
      [/from content\.site_render_config/, () => [{ organization: { name: "Acme" } }]],
      [/from content\.content_sources/, () => drafted.cited],
      [/from content\.authors where id/, () => [author]],
    ]);
  }

  it("republishes the version the page replaced, with no model call, and audits it", async () => {
    const later = new Date("2026-10-02T09:00:00.000Z");
    const sql = db({});
    const r = await rollbackPage(SITE_ID, PATH, { by: USER, reason: "bad edit", now: later }, sql);
    expect(r).toMatchObject({ siteId: SITE_ID, orgId: ORG_ID, contentItemId: "item-1", path: PATH, fromVersionId: "ver-2", toVersionId: "ver-1" });
    const upsert = sql.queries.find((q) => q.text.startsWith("insert into content.published_pages"))!;
    // The stored bytes QA passed, published live under the previous version's id.
    expect(upsert.values.slice(0, 4)).toEqual([SITE_ID, PATH, "item-1", drafted.bodyHtml]);
    expect(upsert.values[8]).toBe("ver-1");
    // A rollback is the one publish that restores: the page goes live with the version asked for.
    expect(upsert.values.slice(10)).toEqual([true, true, true]);
    const flip = sql.queries.find((q) => q.text.startsWith("update content.content_items"))!;
    expect(flip.values).toContain("ver-1");
    const audits = auditOf(sql);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.values).toEqual([ORG_ID, USER, PATH, { __json: { siteId: SITE_ID, path: PATH, versionId: "ver-2" } }, { __json: { siteId: SITE_ID, path: PATH, versionId: "ver-1", reason: "bad edit" } }]);
    expect(audits[0]!.text).toContain("'page.rollback'");
  });

  it("audits the restore too when the rollback lifts a takedown", async () => {
    const sql = db({}, [
      [/^select status from content\.published_pages/, () => [{ status: "noindex" }]],
      [/^insert into content\.published_pages/, () => [{ status: "live" }]],
    ]);
    const r = await rollbackPage(SITE_ID, PATH, { by: USER, reason: "wrong answer" }, sql);
    expect(r).toMatchObject({ status: "live", statusBefore: "noindex" });
    const audits = auditOf(sql);
    expect(audits.map((a) => a.text.match(/'(page\.\w+)'/)?.[1])).toEqual(["page.rollback", "page.live"]);
    expect(audits[1]!.values).toEqual([ORG_ID, USER, PATH, { __json: { siteId: SITE_ID, path: PATH, status: "noindex" } }, { __json: { siteId: SITE_ID, path: PATH, status: "live", reason: "wrong answer", via: "rollback" } }]);
  });

  it("refuses a CMS item: its history lives in the CMS", async () => {
    const sql = db({ origin: "cms" });
    await expect(rollbackPage(SITE_ID, PATH, { by: USER }, sql)).rejects.toThrow(RollbackRefusedError);
    await expect(rollbackPage(SITE_ID, PATH, { by: USER }, sql)).rejects.toThrow(/roll it back there/);
    expect(sql.queries.some((q) => q.text.startsWith("insert into content.published_pages"))).toBe(false);
  });

  it("refuses when there is no earlier version, no page, or no item behind the page", async () => {
    await expect(rollbackPage(SITE_ID, PATH, { by: USER }, db({ previous_version_id: null }))).rejects.toThrow(/no earlier version/);
    await expect(rollbackPage(SITE_ID, PATH, { by: USER }, db(null))).rejects.toThrow(/no published page/);
    await expect(rollbackPage(SITE_ID, PATH, { by: USER }, db({ content_item_id: null }))).rejects.toThrow(/not linked to a content item/);
  });

  it("refuses rather than mint a second URL when the earlier version would publish elsewhere", async () => {
    const sql = db({});
    await expect(rollbackPage(SITE_ID, "/blog/sso-vs-scim", { by: USER }, sql)).rejects.toThrow(/would publish at \/resources\/sso-vs-scim/);
    expect(sql.queries.some((q) => q.text.startsWith("insert into content.published_pages"))).toBe(false);
  });
});

describe("publishGuard", () => {
  const state = (over: Partial<GuardState> = {}): GuardState => ({ site: { status: "active", indexing_paused: false }, controls: [], ...over });
  const control = (scope: "global" | "org" | "site", p: boolean, i: boolean, reason: string | null = null) => ({ scope, publishing_paused: p, indexing_paused: i, reason });

  it("lets an active, unpaused site publish", () => {
    expect(guardVerdict(state())).toEqual({ ok: true });
    expect(guardVerdict(state({ site: { status: "verifying", indexing_paused: false } }))).toEqual({ ok: true });
  });

  it("holds a paused or disabled site, and a site that no longer exists", () => {
    expect(guardVerdict(state({ site: { status: "paused", indexing_paused: false } }))).toEqual({ ok: false, reason: "the project is paused" });
    expect(guardVerdict(state({ site: { status: "disabled", indexing_paused: false } }))).toEqual({ ok: false, reason: "the project is disabled" });
    expect(guardVerdict(state({ site: null }))).toEqual({ ok: false, reason: "the project no longer exists" });
  });

  it("holds on staff controls, naming the widest scope first, publishing before indexing", () => {
    expect(guardVerdict(state({ controls: [control("site", true, false), control("global", true, false, "incident 42")] }))).toEqual({ ok: false, reason: "staff paused publishing on the whole platform: incident 42" });
    expect(guardVerdict(state({ controls: [control("org", false, true), control("site", true, false)] }))).toEqual({ ok: false, reason: "staff paused publishing for this project" });
    expect(guardVerdict(state({ controls: [control("org", false, true)] }))).toEqual({ ok: false, reason: "staff paused indexing for this organisation" });
  });

  it("holds while the owner has paused the site's indexing: nothing new goes live during a takedown", () => {
    expect(guardVerdict(state({ site: { status: "active", indexing_paused: true } }))).toEqual({ ok: false, reason: "indexing is paused for this project" });
  });

  it("reads the site and only the controls that cover it", async () => {
    const sql = fakeSql([
      [/from app\.sites where id/, () => [{ org_id: ORG_ID, status: "active", indexing_paused: false }]],
      [/from ops\.autonomy_controls/, () => [control("org", true, false, "billing")]],
    ]);
    expect(await publishGuard(SITE_ID, sql)).toEqual({ ok: false, reason: "staff paused publishing for this organisation: billing" });
    const q = sql.queries[1]!;
    expect(q.text).toContain("scope = 'global' or (scope = 'org' and org_id = $1) or (scope = 'site' and site_id = $2)");
    expect(q.values).toEqual([ORG_ID, SITE_ID]);
  });
});

describe("holdWhilePaused", () => {
  function fakeStep() {
    const sleeps: { id: string; duration: string }[] = [];
    const step = { async sleep(id: string, duration: string) { sleeps.push({ id, duration }); } };
    return { step: step as unknown as Pick<GateStep, "sleep">, sleeps };
  }

  it("publishes at once when nothing holds, under the caller's original step", async () => {
    const { step, sleeps } = fakeStep();
    const attempts: number[] = [];
    const r = await holdWhilePaused(step, async (n) => (attempts.push(n), { path: PATH }));
    expect(r).toEqual({ path: PATH });
    expect(attempts).toEqual([0]);
    expect(sleeps).toEqual([]);
  });

  it("sleeps an hour per hold and publishes once the pause lifts", async () => {
    const { step, sleeps } = fakeStep();
    const r = await holdWhilePaused(step, async (n) => (n < 3 ? { held: "the project is paused" } : { path: PATH }));
    expect(r).toEqual({ path: PATH });
    expect(sleeps).toEqual([0, 1, 2].map((i) => ({ id: `publish:hold:${i}`, duration: PUBLISH_HOLD })));
  });

  it("gives up after three days and hands the hold back to fail on", async () => {
    const { step, sleeps } = fakeStep();
    const attempts: number[] = [];
    const r = await holdWhilePaused(step, async (n) => (attempts.push(n), { held: "staff paused publishing on the whole platform" }));
    expect(isHeld(r)).toBe(true);
    expect(r).toEqual({ held: "staff paused publishing on the whole platform" });
    expect(sleeps).toHaveLength(PUBLISH_MAX_HOLDS);
    expect(attempts).toHaveLength(PUBLISH_MAX_HOLDS + 1);
    expect(PUBLISH_MAX_HOLDS).toBe(72);
  });

  it("never mistakes a push result list for a hold", () => {
    expect(isHeld([{ targetId: "t1", result: { ok: true } }])).toBe(false);
    expect(isHeld({ ok: false, error: "target not found for site" })).toBe(false);
    expect(isHeld(null)).toBe(false);
  });
});

describe("what the renderer serves and lists", () => {
  const config: SiteRenderConfig = { siteId: SITE_ID, canonicalDomain: "acme.com", pathPrefix: "/resources", locale: "en-US", trailingSlash: "never", theme: { tokens: {} }, organization: { name: "Acme" }, indexingPaused: false };
  const host = { canonicalDomain: "acme.com", indexable: true };
  const at = new Date("2026-09-01T00:00:00.000Z");
  const pages: PageSummary[] = [
    { path: "/resources/sso-vs-scim", head: { title: "SSO vs SCIM" }, updatedAt: at, status: "live" },
    { path: "/resources/noindex-example", head: { title: "Noindex example" }, updatedAt: at, status: "noindex" },
    { path: "/resources/retired-example", head: { title: "Retired example" }, updatedAt: at, status: "retired" },
    { path: "/resources/head-noindex", head: { title: "Head noindex", noindex: true }, updatedAt: at, status: "live" },
  ];

  it("lists live pages only in the sitemap, the feed and llms.txt", () => {
    const listed = listedPages(pages, config);
    expect(listed.map((p) => p.path)).toEqual(["/resources/sso-vs-scim"]);
    const sitemap = buildSitemap(host, listed);
    expect(sitemap).toContain("<loc>https://acme.com/resources/sso-vs-scim</loc>");
    for (const out of [sitemap, buildFeed(host, config, listed), buildLlmsTxt(host, config, listed)]) {
      expect(out).not.toContain("noindex-example");
      expect(out).not.toContain("retired-example");
      expect(out).not.toContain("head-noindex");
    }
  });

  it("lists nothing while the site's indexing is paused", () => {
    const paused = { ...config, indexingPaused: true };
    const listed = listedPages(pages, paused);
    expect(listed).toEqual([]);
    expect(buildSitemap(host, listed)).toBe('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
    expect(buildLlmsTxt(host, paused, listed)).not.toContain("SSO vs SCIM");
  });

  it("renders a noindex page with the robots meta on a verified host", () => {
    const row: PublishedPageRow = { site_id: SITE_ID, path: "/resources/noindex-example", content_item_id: null, status: "noindex", html: "<p>Kept.</p>", head: { title: "Noindex example" }, markdown: "Kept.", etag: "e", updated_at: at };
    const page = toPublishedPage(row);
    expect(page.head.noindex).toBe(true);
    expect(renderArticleDocument({ config, host, page, slug: "noindex-example" })).toContain('<meta name="robots" content="noindex,nofollow">');
    // A live page keeps the head it was published with.
    expect(toPublishedPage({ ...row, status: "live" }).head.noindex).toBeUndefined();
  });

  it("gives a noindex or paused representation its own ETag, so a cache cannot 304 the indexable copy", () => {
    const stored = { etag: '"abc123"', status: "live" as const };
    expect(articleHeaders(stored, config, "html")).toEqual({ etag: '"abc123"' });
    expect(articleHeaders(stored, config, "md")).toEqual({ etag: '"abc123-md"' });
    expect(articleHeaders({ ...stored, status: "noindex" }, config, "html")).toEqual({ etag: '"abc123-noindex"', "x-robots-tag": "noindex" });
    expect(articleHeaders({ ...stored, status: "noindex" }, config, "md")).toEqual({ etag: '"abc123-noindex-md"', "x-robots-tag": "noindex" });
    // The site's pause changes the HTML of every live page, so it changes every tag.
    expect(articleHeaders(stored, { indexingPaused: true }, "html")).toEqual({ etag: '"abc123-noindex"', "x-robots-tag": "noindex" });
    // A tag stored without quotes (the seed's) is quoted once, never twice.
    expect(articleHeaders({ etag: "etag-sso-1", status: "live" }, config, "html").etag).toBe('"etag-sso-1"');
  });
});

describe("owner and staff switches", () => {
  it("setIndexingPaused writes the site flag (the trigger does the rest) and audits it", async () => {
    const sql = fakeSql([[/^update app\.sites set indexing_paused/, () => [{ edge_hostname: "acme-8fj2.blogedge.aeo.app" }]]]);
    expect(await setIndexingPaused(SITE_ID, ORG_ID, true, USER, "legal review", sql)).toBe(true);
    expect(sql.queries[0]!.values).toEqual([true, SITE_ID, ORG_ID]);
    expect(auditOf(sql)[0]!.values).toEqual([ORG_ID, USER, "site.indexing_paused", SITE_ID, { __json: { indexingPaused: true, reason: "legal review" } }]);
  });

  it("setIndexingPaused refuses a site of another org", async () => {
    const sql = fakeSql();
    expect(await setIndexingPaused(SITE_ID, "22222222-2222-2222-2222-222222222222", true, USER, null, sql)).toBe(false);
    expect(auditOf(sql)).toHaveLength(0);
  });

  it("setAutonomyControl inserts a new control, keeps the other switch, and deletes a control with both off", async () => {
    const insert = fakeSql();
    expect(await setAutonomyControl({ scope: "org", id: ORG_ID }, "publishing", true, { by: USER, reason: "billing" }, insert)).toEqual({ orgId: ORG_ID, control: { publishing_paused: true, indexing_paused: false } });
    const ins = insert.queries.find((q) => q.text.startsWith("insert into ops.autonomy_controls"))!;
    expect(ins.values).toEqual(["org", ORG_ID, null, true, false, "billing", USER]);
    expect(auditOf(insert)[0]!.values.slice(0, 3)).toEqual([ORG_ID, USER, "ops.publishing_paused"]);

    const existing = (p: boolean, i: boolean) => fakeSql([
      [/from app\.sites where id/, () => [{ org_id: ORG_ID }]],
      [/from ops\.autonomy_controls/, () => [{ id: "ctl-1", publishing_paused: p, indexing_paused: i }]],
    ]);
    const update = existing(true, false);
    expect((await setAutonomyControl({ scope: "site", id: SITE_ID }, "indexing", true, { by: USER }, update)).control).toEqual({ publishing_paused: true, indexing_paused: true });
    expect(update.queries.some((q) => q.text.startsWith("update ops.autonomy_controls"))).toBe(true);

    const clear = existing(false, true);
    expect(await setAutonomyControl({ scope: "site", id: SITE_ID }, "indexing", false, { by: USER }, clear)).toEqual({ orgId: ORG_ID, control: { publishing_paused: false, indexing_paused: false } });
    expect(clear.queries.find((q) => q.text.startsWith("delete from ops.autonomy_controls"))!.values).toEqual(["ctl-1"]);
    expect(auditOf(clear)[0]!.values[2]).toBe("ops.indexing_resumed");
  });

  it("setAutonomyControl rejects a scope without its target, and a global one with a target", async () => {
    await expect(setAutonomyControl({ scope: "org", id: null }, "publishing", true, { by: USER }, fakeSql())).rejects.toThrow(/needs a target/);
    await expect(setAutonomyControl({ scope: "global", id: ORG_ID }, "publishing", true, { by: USER }, fakeSql())).rejects.toThrow(/names no target/);
  });

  it("controlFor finds the row a scope renders", () => {
    const rows = [
      { scope: "global", org_id: null, site_id: null },
      { scope: "org", org_id: ORG_ID, site_id: null },
      { scope: "site", org_id: ORG_ID, site_id: SITE_ID },
    ] as AutonomyControl[];
    expect(controlFor(rows, { scope: "global", id: null })).toBe(rows[0]);
    expect(controlFor(rows, { scope: "org", id: ORG_ID })).toBe(rows[1]);
    expect(controlFor(rows, { scope: "site", id: SITE_ID })).toBe(rows[2]);
    expect(controlFor(rows, { scope: "site", id: "other" })).toBeNull();
  });
});

describe("notifyOrg", () => {
  const ctxWith = (sql: ReturnType<typeof fakeSql>, fetchImpl: typeof fetch, env: Record<string, string>): ConnectorContext =>
    ({ sql, secrets: {} as ConnectorContext["secrets"], fetchImpl, now: () => when, env: env as NodeJS.ProcessEnv });

  it("emails owners and admins when Resend is configured, with no Slack channel opted in", async () => {
    const sql = fakeSql([[/from app\.memberships m join app\.users u/, () => [{ email: "owner@acme.com" }]]]);
    const ff = fakeFetch({ "https://api.resend.com/emails": { status: 200, body: JSON.stringify({ id: "em1" }) } });
    const r = await notifyOrg(ORG_ID, "acme.com/resources/x was taken down (410 Gone).\nReason: legal", { ctx: ctxWith(sql, ff.fetchImpl, { RESEND_API_KEY: "k", ALERT_EMAIL_FROM: "alerts@aeo.app" }) });
    expect(r).toEqual({ slack: false, email: true, errors: [] });
    expect(ff.callsTo("https://api.resend.com/emails")).toHaveLength(1);
  });

  it("never throws: a failing channel comes back as an error", async () => {
    const sql = fakeSql([[/from app\.memberships m join app\.users u/, () => [{ email: "owner@acme.com" }]]]);
    const broken = (async () => { throw new Error("network down"); }) as typeof fetch;
    const r = await notifyOrg(ORG_ID, "Indexing paused.", { ctx: ctxWith(sql, broken, { RESEND_API_KEY: "k", ALERT_EMAIL_FROM: "alerts@aeo.app" }) });
    expect(r.email).toBe(false);
    expect(r.errors).toEqual(["email: network down"]);
  });

  it("does nothing, quietly, when neither channel is set up", async () => {
    const ff = fakeFetch({});
    expect(await notifyOrg(ORG_ID, "x", { ctx: ctxWith(fakeSql(), ff.fetchImpl, {}) })).toEqual({ slack: false, email: false, errors: [] });
    expect(ff.calls).toHaveLength(0);
  });
});
