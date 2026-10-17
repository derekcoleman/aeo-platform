import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAutonomyControl } from "@/lib/ops/controls";
import { publishGuard } from "@/lib/pipeline/guard";
import { setPageStatus } from "@/lib/pipeline/publish";
import { recomposeFromVersion, rollbackPage } from "@/lib/pipeline/republish";

/**
 * Takedown against the real schema (0020): every control scope and the
 * owner's flag reach content.site_render_config, which the renderer role
 * reads with the grants it already had; publishing rotates the version a
 * rollback returns to; a status change hides a page from the listings, and
 * no publish of the same item but a rollback lifts it.
 * Runs only with AEO_TEST_DATABASE_URL; everything it creates is under two
 * throwaway organisations, removed at the end, and the one global control
 * it sets is removed before the test that sets it ends.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("takedown and kill switch against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
  const ORG = randomUUID();
  const OTHER_ORG = randomUUID();
  const SITE = randomUUID();
  const OTHER_SITE = randomUUID();
  const ITEM = randomUUID();
  const V1 = randomUUID();
  const V2 = randomUUID();
  const STAFF = randomUUID();
  const PATH = "/resources/takedown-test";
  const HELD_ITEM = randomUUID();
  const V3 = randomUUID();
  const V4 = randomUUID();
  const HELD_PATH = "/resources/takedown-held";
  const NEW_ITEM = randomUUID();
  const V5 = randomUUID();
  const TAKEN_PATH = "/resources/takedown-taken";

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Takedown test', ${`takedown-${ORG.slice(0, 8)}`}), (${OTHER_ORG}, 'Takedown other', ${`takedown-${OTHER_ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status) values
      (${SITE}, ${ORG}, 'Takedown test', ${`td-${SITE.slice(0, 8)}.test`}, '/resources', ${`td-${SITE.slice(0, 8)}.blogedge.test`}, 'active'),
      (${OTHER_SITE}, ${OTHER_ORG}, 'Takedown other', ${`td-${OTHER_SITE.slice(0, 8)}.test`}, '/resources', ${`td-${OTHER_SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into content.content_items (id, site_id, slug, title, status) values (${ITEM}, ${SITE}, 'takedown-test', 'Takedown test', 'approved')`;
    await sql`insert into content.content_items (id, site_id, slug, title, status) values (${HELD_ITEM}, ${SITE}, 'takedown-held', 'Takedown held', 'approved')`;
    await sql`insert into content.content_items (id, site_id, slug, title, status) values (${NEW_ITEM}, ${SITE}, 'takedown-taken', 'Takedown taken', 'approved')`;
    for (const [id, item, n, line] of [[V1, ITEM, 1, "The first answer."], [V2, ITEM, 2, "The second answer, which turned out wrong."], [V3, HELD_ITEM, 1, "The answer that was taken down."], [V4, HELD_ITEM, 2, "The rewrite a run had in flight."], [V5, NEW_ITEM, 1, "A new article at a retired path."]] as const) {
      await sql`insert into content.content_versions (id, content_item_id, version_no, title, description, body_md, body_html, frontmatter)
        values (${id}, ${item}, ${n}, 'Takedown test', 'A page to take down.', ${`${line}\n\n## Why it matters\n\nBecause it does.`}, ${`<p>${line}</p>`}, ${sql.json({ intent: "informational", faq: [] })})`;
    }
  });

  afterAll(async () => {
    await sql`delete from ops.autonomy_controls where scope = 'global' and set_by = ${STAFF}`;
    await sql`delete from app.organizations where id in (${ORG}, ${OTHER_ORG})`;
    await sql.end();
  });

  /** What the renderer role sees of a site's pause, through its own grants. */
  const rendererSeesPaused = (siteId: string) =>
    sql.begin(async (tx) => {
      await tx`set local role renderer`;
      const [row] = await tx<{ indexing_paused: boolean }[]>`select indexing_paused from content.site_render_config where site_id = ${siteId}`;
      return row?.indexing_paused;
    });

  it("global, org and site controls and the owner's flag flip the renderer's copy, scoped to what they cover", async () => {
    expect(await rendererSeesPaused(SITE)).toBe(false);

    await setAutonomyControl({ scope: "site", id: SITE }, "indexing", true, { by: STAFF }, sql);
    expect([await rendererSeesPaused(SITE), await rendererSeesPaused(OTHER_SITE)]).toEqual([true, false]);
    await setAutonomyControl({ scope: "site", id: SITE }, "indexing", false, { by: STAFF }, sql);
    expect(await rendererSeesPaused(SITE)).toBe(false);

    await setAutonomyControl({ scope: "org", id: OTHER_ORG }, "indexing", true, { by: STAFF }, sql);
    expect([await rendererSeesPaused(SITE), await rendererSeesPaused(OTHER_SITE)]).toEqual([false, true]);
    // Publishing on the same row leaves indexing as it is.
    await setAutonomyControl({ scope: "org", id: OTHER_ORG }, "publishing", true, { by: STAFF }, sql);
    expect(await rendererSeesPaused(OTHER_SITE)).toBe(true);
    expect(await publishGuard(OTHER_SITE, sql)).toEqual({ ok: false, reason: "staff paused publishing for this organisation" });
    await setAutonomyControl({ scope: "org", id: OTHER_ORG }, "indexing", false, { by: STAFF }, sql);
    await setAutonomyControl({ scope: "org", id: OTHER_ORG }, "publishing", false, { by: STAFF }, sql);
    expect(await rendererSeesPaused(OTHER_SITE)).toBe(false);
    expect(await sql`select 1 from ops.autonomy_controls where org_id = ${OTHER_ORG}`).toHaveLength(0);

    await sql`update app.sites set indexing_paused = true where id = ${SITE}`;
    expect(await rendererSeesPaused(SITE)).toBe(true);
    expect(await publishGuard(SITE, sql)).toEqual({ ok: false, reason: "indexing is paused for this project" });
    await sql`update app.sites set indexing_paused = false where id = ${SITE}`;
    expect(await rendererSeesPaused(SITE)).toBe(false);
    expect(await publishGuard(SITE, sql)).toEqual({ ok: true });

    try {
      await setAutonomyControl({ scope: "global", id: null }, "indexing", true, { by: STAFF, reason: "test" }, sql);
      expect([await rendererSeesPaused(SITE), await rendererSeesPaused(OTHER_SITE)]).toEqual([true, true]);
      expect(await publishGuard(SITE, sql)).toEqual({ ok: false, reason: "staff paused indexing on the whole platform: test" });
    } finally {
      await setAutonomyControl({ scope: "global", id: null }, "indexing", false, { by: STAFF }, sql);
    }
    expect([await rendererSeesPaused(SITE), await rendererSeesPaused(OTHER_SITE)]).toEqual([false, false]);

    const audited = await sql<{ action: string }[]>`select action from app.audit_log where actor_user_id = ${STAFF} order by id`;
    expect(audited.map((a) => a.action)).toContain("ops.indexing_paused");
  });

  it("publishing rotates the version, a rollback returns to it, and a status change hides the page from listings", async () => {
    const page = () => sql<{ status: string; version_id: string | null; previous_version_id: string | null; html: string }[]>`
      select status::text as status, version_id, previous_version_id, html from content.published_pages where site_id = ${SITE} and path = ${PATH}`.then((r) => r[0]);

    await recomposeFromVersion({ contentItemId: ITEM, versionId: V1, siteId: SITE }, sql);
    expect(await page()).toMatchObject({ status: "live", version_id: V1, previous_version_id: null });
    await recomposeFromVersion({ contentItemId: ITEM, versionId: V2, siteId: SITE }, sql);
    expect(await page()).toMatchObject({ status: "live", version_id: V2, previous_version_id: V1 });
    // Republishing the same version keeps the rollback target.
    await recomposeFromVersion({ contentItemId: ITEM, versionId: V2, siteId: SITE }, sql);
    expect(await page()).toMatchObject({ version_id: V2, previous_version_id: V1 });

    // Take it down, then roll back: the earlier version goes live, and the bad one is the new rollback target.
    await setPageStatus(SITE, PATH, "noindex", { by: STAFF, reason: "wrong answer" }, sql);
    const listed = () => sql.begin(async (tx) => {
      await tx`set local role renderer`;
      return tx<{ path: string; status: string }[]>`select path, status::text as status from content.published_pages where site_id = ${SITE} and status = 'live'`;
    });
    expect(await listed()).toEqual([]);
    expect(await page()).toMatchObject({ status: "noindex" });

    const r = await rollbackPage(SITE, PATH, { by: STAFF, reason: "wrong answer" }, sql);
    expect(r).toMatchObject({ path: PATH, fromVersionId: V2, toVersionId: V1 });
    expect(await page()).toMatchObject({ status: "live", version_id: V1, previous_version_id: V2 });
    expect((await page())!.html).toContain("The first answer.");
    expect(await listed()).toEqual([{ path: PATH, status: "live" }]);
    const [item] = await sql<{ current_version_id: string }[]>`select current_version_id from content.content_items where id = ${ITEM}`;
    expect(item!.current_version_id).toBe(V1);

    const actions = await sql<{ action: string }[]>`select action from app.audit_log where target_id = ${PATH} and actor_user_id = ${STAFF} order by id`;
    expect(actions.map((a) => a.action)).toEqual(["page.noindex", "page.rollback", "page.live"]);
  });

  it("a takedown outlasts a run that was in flight: its version waits behind it until Restore", async () => {
    const page = () => sql<{ status: string; status_reason: string | null; version_id: string | null; previous_version_id: string | null; html: string }[]>`
      select status::text as status, status_reason, version_id, previous_version_id, html from content.published_pages where site_id = ${SITE} and path = ${HELD_PATH}`.then((r) => r[0]);
    await recomposeFromVersion({ contentItemId: HELD_ITEM, versionId: V3, siteId: SITE }, sql);
    await setPageStatus(SITE, HELD_PATH, "retired", { by: STAFF, reason: "legal takedown" }, sql);

    // What the pipeline's publish step does once publishGuard lets it through.
    expect(await publishGuard(SITE, sql)).toEqual({ ok: true });
    const published = await recomposeFromVersion({ contentItemId: HELD_ITEM, versionId: V4, siteId: SITE }, sql);
    expect(published).toMatchObject({ status: "retired", statusBefore: "retired" });
    expect(await page()).toMatchObject({ status: "retired", status_reason: "legal takedown", version_id: V4, previous_version_id: V3 });
    const audited = () => sql<{ action: string }[]>`select action from app.audit_log where target_id = ${HELD_PATH} and actor_user_id = ${STAFF} order by id`.then((r) => r.map((a) => a.action));
    expect(await audited()).toEqual(["page.retired"]);

    // Restoring is a decision someone makes, and it serves the version published behind the takedown.
    await setPageStatus(SITE, HELD_PATH, "live", { by: STAFF }, sql);
    expect(await page()).toMatchObject({ status: "live", status_reason: null, version_id: V4 });
    expect((await page())!.html).toContain("The rewrite a run had in flight.");
    expect(await audited()).toEqual(["page.retired", "page.live"]);
  });

  it("another item taking a retired path goes live: the takedown was the old article's", async () => {
    // A page left behind by an item since deleted (or never linked to one), retired.
    await sql`insert into content.published_pages (site_id, path, html, markdown, etag, head, status, status_reason)
      values (${SITE}, ${TAKEN_PATH}, '<p>old</p>', 'old', '"old"', '{}'::jsonb, 'retired', 'legal takedown')`;
    const published = await recomposeFromVersion({ contentItemId: NEW_ITEM, versionId: V5, siteId: SITE }, sql);
    expect(published).toMatchObject({ status: "live", statusBefore: "retired" });
    const [row] = await sql<{ content_item_id: string; status: string; status_reason: string | null; version_id: string; previous_version_id: string | null }[]>`
      select content_item_id, status::text as status, status_reason, version_id, previous_version_id from content.published_pages where site_id = ${SITE} and path = ${TAKEN_PATH}`;
    expect(row).toEqual({ content_item_id: NEW_ITEM, status: "live", status_reason: null, version_id: V5, previous_version_id: null });
    const audited = await sql<{ action: string; actor_user_id: string | null; after: { via?: string; contentItemId?: string } }[]>`
      select action, actor_user_id, after from app.audit_log where org_id = ${ORG} and target_id = ${TAKEN_PATH} order by id`;
    expect(audited).toEqual([{ action: "page.live", actor_user_id: null, after: expect.objectContaining({ via: "takeover", contentItemId: NEW_ITEM }) }]);
  });

  it("a kill switch and a site edit in flight at once both reach the renderer, whichever commits first", async () => {
    // One connection holds its write open while a second runs into it; the
    // second must compute the effective pause after the first commits, not before.
    const held = await sql.reserve();
    const peer = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
    const blocked = async (like: string) => {
      for (let i = 0; i < 100; i++) {
        const [w] = await peer<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like ${like}`;
        if (w!.n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no session blocked on: ${like}`);
    };
    let open = false;
    try {
      // Staff pause the org while someone edits the site.
      await held`begin`;
      open = true;
      await held`insert into ops.autonomy_controls (scope, org_id, indexing_paused, reason, set_by) values ('org', ${ORG}, true, 'race', ${STAFF})`;
      const edit = peer`update app.sites set locale = locale where id = ${SITE}`.execute();
      await blocked("update app.sites set locale%");
      await held`commit`;
      open = false;
      await edit;
      expect(await rendererSeesPaused(SITE)).toBe(true);

      // The owner pauses the site while staff lift the org's pause.
      await held`begin`;
      open = true;
      await held`update app.sites set indexing_paused = true where id = ${SITE}`;
      const lift = peer`delete from ops.autonomy_controls where scope = 'org' and org_id = ${ORG}`.execute();
      await blocked("delete from ops.autonomy_controls%");
      await held`commit`;
      open = false;
      await lift;
      expect(await rendererSeesPaused(SITE)).toBe(true);
    } finally {
      if (open) await held`rollback`;
      held.release();
      await sql`delete from ops.autonomy_controls where scope = 'org' and org_id = ${ORG}`;
      await sql`update app.sites set indexing_paused = false where id = ${SITE}`;
      await peer.end();
    }
    expect(await rendererSeesPaused(SITE)).toBe(false);
  });
});
