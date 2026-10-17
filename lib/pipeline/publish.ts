import { createHash } from "node:crypto";
import { appDb } from "@/lib/db/app";
import type { PageHead, PageStatus } from "@/lib/render/published";
import { buildArticleJsonLd, type ArticleSource, type FaqEntry } from "@/lib/render/jsonld";
import { toSiteRoute, type SiteRow } from "@/lib/tenancy/store";
import type { PublicHostResolution, SiteRoute } from "@/lib/tenancy/types";
import { assertNoEdgeHostname, contentUrl } from "@/lib/tenancy/urls";
import type postgres from "postgres";
import type { AuthorRow } from "./versions";

/**
 * Publish = materialise one version into content.published_pages, the
 * renderer's only read table. Everything the renderer needs is computed here
 * once (head, JSON-LD, etag) so the hot path is a primary-key lookup.
 */

export interface PublishInputs {
  site: SiteRoute;
  organization: { name?: string; url?: string; logo?: string };
  slug: string;
  title: string;
  description: string | null;
  bodyHtml: string;
  bodyMd: string;
  author: AuthorRow | null;
  citations: ArticleSource[];
  faq: FaqEntry[];
  datePublished: Date;
  dateModified?: Date;
  image?: string | null;
}

export interface BuiltPage {
  path: string;
  canonicalUrl: string;
  html: string;
  head: PageHead;
  markdown: string;
  etag: string;
  jsonLd: unknown;
}

export function pagePath(site: Pick<SiteRoute, "pathPrefix" | "trailingSlash">, slug: string): string {
  const base = `${site.pathPrefix}/${slug}`;
  return site.trailingSlash === "always" ? `${base}/` : base;
}

/** Pure: everything a published_pages row holds, plus the JSON-LD for QA. Throws if any byte would leak the edge hostname. */
export function buildPublishedPage(input: PublishInputs): BuiltPage {
  const host: PublicHostResolution = { canonicalDomain: input.site.canonicalDomain, indexable: true };
  const organizationName = input.organization.name ?? input.site.canonicalDomain;
  const author = input.author
    ? { name: input.author.name, url: input.author.url, jobTitle: input.author.job_title, sameAs: input.author.same_as ?? [] }
    : null;
  const jsonLd = buildArticleJsonLd({
    site: input.site,
    host,
    slug: input.slug,
    title: input.title,
    description: input.description,
    datePublished: input.datePublished.toISOString(),
    dateModified: (input.dateModified ?? input.datePublished).toISOString(),
    author,
    organizationName,
    organizationUrl: input.organization.url ?? null,
    organizationLogo: input.organization.logo ?? null,
    image: input.image ?? null,
    citations: input.citations,
    faq: input.faq,
  });
  const head: PageHead = {
    title: input.title,
    slug: input.slug,
    datePublished: input.datePublished.toISOString(),
    dateModified: (input.dateModified ?? input.datePublished).toISOString(),
    jsonLd,
    ...(input.description ? { description: input.description } : {}),
    ...(author ? { author: { name: author.name, ...(author.url ? { url: author.url } : {}), ...(author.jobTitle ? { jobTitle: author.jobTitle } : {}), ...(author.sameAs.length ? { sameAs: author.sameAs } : {}) } } : {}),
    ...(input.image ? { image: input.image } : {}),
  };
  const markdown = `# ${input.title}\n\n${input.bodyMd.trim()}\n`;
  const etag = `"${createHash("sha256").update(input.bodyHtml).update(JSON.stringify(head)).digest("hex").slice(0, 32)}"`;
  const page: BuiltPage = { path: pagePath(input.site, input.slug), canonicalUrl: contentUrl(host, input.site, input.slug), html: input.bodyHtml, head, markdown, etag, jsonLd };
  assertNoEdgeHostname(page.html, "published html");
  assertNoEdgeHostname(page.markdown, "published markdown");
  assertNoEdgeHostname(JSON.stringify(page.head), "published head");
  return page;
}

export async function loadSiteRoute(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteRoute | null> {
  const [row] = await sql<SiteRow[]>`
    select id, org_id, canonical_domain, path_prefix, edge_hostname, proxy_mode, trailing_slash, locale, status
    from app.sites where id = ${siteId}`;
  if (!row) return null;
  const domains = await sql<{ hostname: string }[]>`select hostname from app.site_domains where site_id = ${siteId}`;
  return toSiteRoute({ ...row, site_domains: domains });
}

export async function loadSiteOrganization(siteId: string, sql: postgres.Sql = appDb()): Promise<PublishInputs["organization"]> {
  const [row] = await sql<{ organization: PublishInputs["organization"] | null }[]>`
    select organization from content.site_render_config where site_id = ${siteId}`;
  return row?.organization ?? {};
}

export interface PublishResult {
  path: string;
  canonicalUrl: string;
  etag: string;
  /** The page's status once published: live, unless this item's page was taken down and the caller did not restore it. */
  status: PageStatus;
  /** Its status before, or null for a page published for the first time. */
  statusBefore: PageStatus | null;
}

/**
 * One transaction: published_pages upsert + content_items flip. A half-published item is not a state.
 *
 * A takedown outlasts any publish of the same item. A page that is noindex
 * or retired keeps that status: a pipeline run that was in flight, or held
 * at its publish step, when the page was taken down publishes its version
 * behind the takedown, and Restore is what puts it live. Only `restore` (a
 * rollback an editor asked for) makes the page live again. The row records
 * the version it was built from and, when that changes, the one it
 * replaced, which is what rollbackPage republishes. A path taken over by
 * another item starts afresh: live, since the takedown was the old
 * article's (audited as such), and with no previous version, since rolling
 * back must never put another item's article on it.
 */
export async function publishVersion(
  input: { contentItemId: string; versionId: string; siteId: string; page: BuiltPage; now?: Date; restore?: boolean },
  sql: postgres.Sql = appDb(),
): Promise<PublishResult> {
  const now = input.now ?? new Date();
  const restore = input.restore === true;
  const { status, statusBefore } = (await sql.begin(async (tx) => {
    // Locked, so the status read is the one the upsert keeps or replaces.
    const [before] = await tx<{ status: PageStatus }[]>`
      select status from content.published_pages where site_id = ${input.siteId} and path = ${input.page.path} for update`;
    const [after] = await tx<{ status: PageStatus }[]>`
      insert into content.published_pages (site_id, path, content_item_id, html, head, markdown, etag, updated_at, version_id, status, status_changed_at)
      values (${input.siteId}, ${input.page.path}, ${input.contentItemId}, ${input.page.html}, ${tx.json(input.page.head as never)}, ${input.page.markdown}, ${input.page.etag}, ${now}, ${input.versionId}, 'live', ${now})
      on conflict (site_id, path) do update set
        content_item_id = excluded.content_item_id, html = excluded.html, head = excluded.head,
        markdown = excluded.markdown, etag = excluded.etag, updated_at = excluded.updated_at,
        previous_version_id = case
          when published_pages.content_item_id is distinct from excluded.content_item_id then null
          when published_pages.version_id is distinct from excluded.version_id then published_pages.version_id
          else published_pages.previous_version_id end,
        version_id = excluded.version_id,
        status = case when ${restore}::boolean or published_pages.content_item_id is distinct from excluded.content_item_id then 'live' else published_pages.status end,
        status_changed_at = case when (${restore}::boolean or published_pages.content_item_id is distinct from excluded.content_item_id) and published_pages.status <> 'live' then excluded.updated_at else published_pages.status_changed_at end,
        status_reason = case when (${restore}::boolean or published_pages.content_item_id is distinct from excluded.content_item_id) and published_pages.status <> 'live' then null else published_pages.status_reason end
      returning status`;
    if (!restore && before && before.status !== "live" && after?.status === "live") {
      // Only a takeover lifts a takedown here; a restore's caller audits its own.
      await tx`
        insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, before, after)
        select org_id, null, 'page.live', 'page', ${input.page.path},
               ${tx.json({ siteId: input.siteId, path: input.page.path, status: before.status } as never)},
               ${tx.json({ siteId: input.siteId, path: input.page.path, status: "live", via: "takeover", contentItemId: input.contentItemId } as never)}
        from app.sites where id = ${input.siteId}`;
    }
    await tx`
      update content.content_items set
        status = 'published', title = ${input.page.head.title ?? null}, current_version_id = ${input.versionId},
        canonical_url = ${input.page.canonicalUrl}, published_at = ${now},
        first_published_at = coalesce(first_published_at, ${now}), updated_at = ${now}
      where id = ${input.contentItemId}`;
    return { status: after?.status ?? "live", statusBefore: before?.status ?? null };
  })) as { status: PageStatus; statusBefore: PageStatus | null };
  return { path: input.page.path, canonicalUrl: input.page.canonicalUrl, etag: input.page.etag, status, statusBefore };
}

export interface PageStatusChange {
  siteId: string;
  orgId: string;
  path: string;
  contentItemId: string | null;
  /** The version the page serves, which a restore copies to the publishing targets. */
  versionId: string | null;
  before: PageStatus;
  after: PageStatus;
  changed: boolean;
}

/**
 * Take a page out of the index (noindex), take it down (retired: 410), or
 * restore it (live). The renderer reads the status on every request, so the
 * change holds from the next one; a CDN may serve its copy for up to the
 * 5-minute s-maxage. Writes the audit row in the same transaction. Returns
 * null when the site has no page at that path; a page already in the asked
 * status is left alone and not audited again.
 */
export async function setPageStatus(
  siteId: string,
  path: string,
  status: PageStatus,
  opts: { by: string | null; reason?: string | null; now?: Date },
  sql: postgres.Sql = appDb(),
): Promise<PageStatusChange | null> {
  const now = opts.now ?? new Date();
  const reason = opts.reason?.trim().slice(0, 500) || null;
  return sql.begin(async (tx) => {
    const [row] = await tx<{ org_id: string; content_item_id: string | null; version_id: string | null; status: PageStatus }[]>`
      select s.org_id, p.content_item_id, p.version_id, p.status
      from content.published_pages p join app.sites s on s.id = p.site_id
      where p.site_id = ${siteId} and p.path = ${path}
      for update of p`;
    if (!row) return null;
    const change: PageStatusChange = { siteId, orgId: row.org_id, path, contentItemId: row.content_item_id, versionId: row.version_id ?? null, before: row.status, after: status, changed: row.status !== status };
    if (!change.changed) return change;
    await tx`
      update content.published_pages set status = ${status}, status_changed_at = ${now}, status_reason = ${status === "live" ? null : reason}
      where site_id = ${siteId} and path = ${path}`;
    await tx`
      insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, before, after)
      values (${row.org_id}, ${opts.by}, ${`page.${status}`}, 'page', ${path},
              ${tx.json({ siteId, path, status: row.status } as never)}, ${tx.json({ siteId, path, status, reason } as never)})`;
    return change;
  }) as Promise<PageStatusChange | null>;
}

/** Is the item's page out of the index or taken down? A cms item, which has no page here, is not. */
export async function isTakenDown(contentItemId: string, sql: postgres.Sql = appDb()): Promise<boolean> {
  const rows = await sql`select 1 from content.published_pages where content_item_id = ${contentItemId} and status <> 'live' limit 1`;
  return rows.length > 0;
}
