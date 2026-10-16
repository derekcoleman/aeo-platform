import { appDb } from "@/lib/db/app";
import type { PageHead } from "@/lib/render/published";
import type postgres from "postgres";
import { composeVersion, type Composed } from "./compose";
import { FAQ_HEADING, faqSectionCount } from "./markdown";
import { loadSiteOrganization, loadSiteRoute, publishVersion, type PublishResult } from "./publish";
import { defaultAuthor, loadSources, loadVersion, type AuthorRow } from "./versions";

/**
 * Rebuild a page from a stored version, with no model call. The version's
 * markdown already ends in its FAQ section (composeVersion appended it when
 * the draft was written), so it is recomposed with `faqIncluded`: the HTML
 * that passed QA is the HTML that goes live, byte for byte.
 */

export interface RecomposeInput {
  contentItemId: string;
  versionId: string;
  siteId: string;
  now?: Date;
  /** Keep the page's visible "updated" date (a formatting fix is not an update). Defaults to `now`. */
  dateModified?: Date;
}

/** Load everything a version's page is built from and compose it. Throws if the ids do not belong together. */
export async function composeFromVersion(input: RecomposeInput, sql: postgres.Sql = appDb()): Promise<Composed> {
  const now = input.now ?? new Date();
  const version = await loadVersion(input.versionId, sql);
  if (!version) throw new Error(`version ${input.versionId} not found`);
  if (version.content_item_id !== input.contentItemId) throw new Error(`version ${input.versionId} belongs to another content item`);
  const [item] = await sql<{ site_id: string; slug: string; author_id: string | null; first_published_at: Date | null }[]>`
    select site_id, slug, author_id, first_published_at from content.content_items where id = ${input.contentItemId}`;
  if (!item || item.site_id !== input.siteId) throw new Error(`content item ${input.contentItemId} is not on site ${input.siteId}`);
  const route = await loadSiteRoute(input.siteId, sql);
  if (!route) throw new Error(`site ${input.siteId} not found`);
  const [organization, sources, author] = await Promise.all([loadSiteOrganization(input.siteId, sql), loadSources(input.versionId, sql), authorFor(item.author_id, input.siteId, sql)]);
  return composeVersion({
    draft: { title: version.title, description: version.description ?? "", bodyMd: version.body_md, faq: version.frontmatter.faq },
    brief: { sources, intent: version.frontmatter.intent },
    site: route,
    organization,
    author,
    slug: item.slug,
    datePublished: item.first_published_at ?? now,
    dateModified: input.dateModified ?? now,
    faqIncluded: true,
  });
}

async function authorFor(authorId: string | null, siteId: string, sql: postgres.Sql): Promise<AuthorRow | null> {
  if (authorId) {
    const [row] = await sql<AuthorRow[]>`select id, name, job_title, url, same_as from content.authors where id = ${authorId} and site_id = ${siteId}`;
    if (row) return row;
  }
  return defaultAuthor(siteId, sql);
}

/** Compose a stored version and publish it (published_pages upsert + content item flip, one transaction). */
export async function recomposeFromVersion(input: RecomposeInput, sql: postgres.Sql = appDb()): Promise<PublishResult> {
  const now = input.now ?? new Date();
  const composed = await composeFromVersion({ ...input, now }, sql);
  return publishVersion({ contentItemId: input.contentItemId, versionId: input.versionId, siteId: input.siteId, page: composed.page, now }, sql);
}

export { FAQ_HEADING };

export interface FaqRemediation {
  siteId: string;
  orgId: string;
  paths: string[];
  skipped: { path: string; reason: string }[];
  /** Webflow copies to push again: the old push appended the FAQ to a body that already ended in it. */
  repush: { contentItemId: string; targetId: string }[];
}

const DUPLICATE_FAQ_PATTERN = `%${FAQ_HEADING}%${FAQ_HEADING}%`;

/** Sites with a pipeline page that carries its FAQ section twice; one site, or all of them for null. */
export async function sitesWithDuplicateFaq(siteId: string | null, sql: postgres.Sql = appDb()): Promise<string[]> {
  const rows = await sql<{ site_id: string }[]>`
    select distinct p.site_id
    from content.published_pages p
    join content.content_items i on i.id = p.content_item_id
    where (${siteId}::uuid is null or p.site_id = ${siteId}::uuid)
      and p.markdown like ${DUPLICATE_FAQ_PATTERN}
      and i.origin = 'pipeline' and i.current_version_id is not null
    order by p.site_id`;
  return rows.map((r) => r.site_id);
}

type DuplicateFaqPage = { site_id: string; org_id: string; path: string; content_item_id: string; version_id: string; etag: string; head: PageHead };

/**
 * Pages published before the FAQ fix carry their FAQ section twice (the
 * stored markdown already had it, and publish appended it again). Rebuild
 * each one from its current version and rewrite only the page row: the
 * content item's publish dates feed attribution windows and must not move.
 * A page is rewritten only if it still holds the bytes that were read: one
 * republished in the meantime is newer than the version recomposed here.
 * Each site's audit row lists the paths it fixed and is written as soon as
 * that site is done, even when a page throws partway, so a retry (which
 * finds only the pages still broken) never leaves rewritten pages unaudited.
 */
export async function remediateDuplicateFaq(
  siteId: string | null,
  opts: { actorUserId?: string | null; now?: Date } = {},
  sql: postgres.Sql = appDb(),
): Promise<FaqRemediation[]> {
  const now = opts.now ?? new Date();
  const rows = await sql<DuplicateFaqPage[]>`
    select p.site_id, s.org_id, p.path, p.content_item_id, i.current_version_id as version_id, p.etag, p.head
    from content.published_pages p
    join content.content_items i on i.id = p.content_item_id
    join app.sites s on s.id = p.site_id
    where (${siteId}::uuid is null or p.site_id = ${siteId}::uuid)
      and p.markdown like ${DUPLICATE_FAQ_PATTERN}
      and i.origin = 'pipeline' and i.current_version_id is not null
    order by p.site_id, p.path`;
  const bySite = new Map<string, DuplicateFaqPage[]>();
  for (const r of rows) {
    const pages = bySite.get(r.site_id);
    if (pages) pages.push(r);
    else bySite.set(r.site_id, [r]);
  }
  const results: FaqRemediation[] = [];
  for (const pages of bySite.values()) results.push(await remediateSite(pages, opts.actorUserId ?? null, now, sql));
  return results;
}

async function remediateSite(pages: DuplicateFaqPage[], actorUserId: string | null, now: Date, sql: postgres.Sql): Promise<FaqRemediation> {
  const out: FaqRemediation = { siteId: pages[0]!.site_id, orgId: pages[0]!.org_id, paths: [], skipped: [], repush: [] };
  try {
    for (const r of pages) {
      let composed: Composed;
      try {
        composed = await composeFromVersion(
          { contentItemId: r.content_item_id, versionId: r.version_id, siteId: r.site_id, now, dateModified: r.head?.dateModified ? new Date(r.head.dateModified) : undefined },
          sql,
        );
      } catch (e) {
        out.skipped.push({ path: r.path, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (composed.page.path !== r.path) {
        // The site's prefix or slash policy changed since; republishing would mint a second URL.
        out.skipped.push({ path: r.path, reason: `recomposed path is ${composed.page.path}` });
        continue;
      }
      if (faqSectionCount(composed.page.markdown) > 1) {
        // The version itself carries the section twice (its body kept a FAQ and the draft answered one too).
        out.skipped.push({ path: r.path, reason: "the version's own body carries the FAQ twice; it needs a new draft" });
        continue;
      }
      const updated = await sql`
        update content.published_pages set
          html = ${composed.page.html}, head = ${sql.json(composed.page.head as never)}, markdown = ${composed.page.markdown},
          etag = ${composed.page.etag}, updated_at = ${now}
        where site_id = ${r.site_id} and path = ${r.path} and content_item_id = ${r.content_item_id} and etag = ${r.etag}
        returning path`;
      if (updated.length === 0) {
        out.skipped.push({ path: r.path, reason: "changed since selected" });
        continue;
      }
      out.paths.push(r.path);
    }
    out.repush = await webflowCopiesToRepush(out.siteId, sql);
  } finally {
    await sql`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
      values (${out.orgId}, ${actorUserId}, 'content.remediate_faq', 'site', ${out.siteId}, ${sql.json({ paths: out.paths, skipped: out.skipped, repush: out.repush } as never)})`;
  }
  return out;
}

/**
 * Webflow copies pushed before the fix print the FAQ twice as well: the push
 * appended the FAQ to a stored body that already ended in it. Every pipeline
 * item with FAQ entries whose copy on an enabled target is still the current
 * version is pushed again; the push is idempotent on payload, so a copy that
 * is already right is left alone, and only the version already there is
 * sent, never a newer one to a target that publishes by hand. CMS posts
 * refreshed in place are not re-sent: that would overwrite edits made in the
 * CMS since, so they wait for their next refresh.
 */
export async function webflowCopiesToRepush(siteId: string, sql: postgres.Sql = appDb()): Promise<{ contentItemId: string; targetId: string }[]> {
  const rows = await sql<{ content_item_id: string; target_id: string }[]>`
    select e.content_item_id, e.target_id
    from content.external_publications e
    join content.publish_targets t on t.id = e.target_id
    join content.content_items i on i.id = e.content_item_id
    join content.content_versions v on v.id = i.current_version_id
    where e.site_id = ${siteId} and e.status = 'published' and t.enabled and t.kind = 'webflow'
      and i.origin = 'pipeline' and e.version_id = i.current_version_id
      and jsonb_array_length(coalesce(v.frontmatter->'faq', '[]'::jsonb)) > 0
    order by e.content_item_id, e.target_id`;
  return rows.map((r) => ({ contentItemId: r.content_item_id, targetId: r.target_id }));
}
