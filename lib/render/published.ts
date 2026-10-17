import { rendererDb } from "./db";

/**
 * live: served and listed. noindex: still served, marked noindex, never
 * listed. retired: answered with 410 and never listed (migration 0020).
 */
export type PageStatus = "live" | "noindex" | "retired";

export interface PublishedPage {
  siteId: string;
  path: string;
  contentItemId: string | null;
  status: PageStatus;
  html: string;
  head: PageHead;
  markdown: string | null;
  etag: string;
  updatedAt: Date;
}

/**
 * Everything needed to build <head> without a second query.
 *
 * Theme deliberately is NOT here: it belongs to the site, not the page, and
 * lives in content.site_render_config. Copying it onto every row would mean a
 * theme change had to rewrite every published page.
 */
export interface PageHead {
  title?: string;
  description?: string;
  slug?: string;
  datePublished?: string;
  dateModified?: string;
  author?: { name: string; url?: string; jobTitle?: string; sameAs?: string[] };
  image?: string;
  jsonLd?: unknown;
  noindex?: boolean;
}

export interface PublishedPageRow {
  site_id: string;
  path: string;
  content_item_id: string | null;
  status: PageStatus;
  html: string;
  head: PageHead;
  markdown: string | null;
  etag: string;
  updated_at: Date;
}

export async function getPublishedPage(
  siteId: string,
  path: string,
): Promise<PublishedPage | null> {
  const rows = await rendererDb()<PublishedPageRow[]>`
    select site_id, path, content_item_id, status, html, head, markdown, etag, updated_at
    from content.published_pages
    where site_id = ${siteId}::uuid and path = ${path}
    limit 1
  `;
  const row = rows[0];
  return row ? toPublishedPage(row) : null;
}

export function toPublishedPage(row: PublishedPageRow): PublishedPage {
  const head = row.head ?? {};
  return {
    siteId: row.site_id,
    path: row.path,
    contentItemId: row.content_item_id,
    status: row.status ?? "live",
    html: row.html,
    // A page taken out of the index renders noindex through the same head flag
    // a page-level noindex always used.
    head: row.status === "noindex" ? { ...head, noindex: true } : head,
    markdown: row.markdown,
    etag: row.etag,
    updatedAt: row.updated_at,
  };
}

/** Index listing and sitemap/feed/llms.txt generation: live pages only. */
export async function listPublishedPages(
  siteId: string,
  limit = 1000,
): Promise<Pick<PublishedPage, "path" | "head" | "updatedAt" | "status">[]> {
  const rows = await rendererDb()<{ path: string; head: PageHead; updated_at: Date; status: PageStatus }[]>`
    select path, head, updated_at, status
    from content.published_pages
    where site_id = ${siteId}::uuid and status = 'live'
    order by updated_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({ path: r.path, head: r.head ?? {}, updatedAt: r.updated_at, status: r.status }));
}

/**
 * llms-full.txt needs the markdown body, which the listing query deliberately
 * omits — pulling full text for a sitemap or feed would be wasteful.
 */
export async function listPublishedPagesWithMarkdown(
  siteId: string,
  limit = 2000,
): Promise<(Pick<PublishedPage, "path" | "head" | "updatedAt" | "status"> & { markdown: string | null })[]> {
  const rows = await rendererDb()<
    { path: string; head: PageHead; updated_at: Date; status: PageStatus; markdown: string | null }[]
  >`
    select path, head, updated_at, status, markdown
    from content.published_pages
    where site_id = ${siteId}::uuid and status = 'live' and markdown is not null
    order by updated_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    path: r.path,
    head: r.head ?? {},
    updatedAt: r.updated_at,
    status: r.status,
    markdown: r.markdown,
  }));
}
