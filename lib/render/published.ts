import { rendererDb } from "./db";

export interface PublishedPage {
  siteId: string;
  path: string;
  contentItemId: string | null;
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

export async function getPublishedPage(
  siteId: string,
  path: string,
): Promise<PublishedPage | null> {
  const rows = await rendererDb()<
    {
      site_id: string;
      path: string;
      content_item_id: string | null;
      html: string;
      head: PageHead;
      markdown: string | null;
      etag: string;
      updated_at: Date;
    }[]
  >`
    select site_id, path, content_item_id, html, head, markdown, etag, updated_at
    from content.published_pages
    where site_id = ${siteId}::uuid and path = ${path}
    limit 1
  `;

  const row = rows[0];
  if (!row) return null;
  return {
    siteId: row.site_id,
    path: row.path,
    contentItemId: row.content_item_id,
    html: row.html,
    head: row.head ?? {},
    markdown: row.markdown,
    etag: row.etag,
    updatedAt: row.updated_at,
  };
}

/** Index listing and sitemap/feed/llms.txt generation. */
export async function listPublishedPages(
  siteId: string,
  limit = 1000,
): Promise<Pick<PublishedPage, "path" | "head" | "updatedAt">[]> {
  const rows = await rendererDb()<{ path: string; head: PageHead; updated_at: Date }[]>`
    select path, head, updated_at
    from content.published_pages
    where site_id = ${siteId}::uuid
    order by updated_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({ path: r.path, head: r.head ?? {}, updatedAt: r.updated_at }));
}

/**
 * llms-full.txt needs the markdown body, which the listing query deliberately
 * omits — pulling full text for a sitemap or feed would be wasteful.
 */
export async function listPublishedPagesWithMarkdown(
  siteId: string,
  limit = 2000,
): Promise<(Pick<PublishedPage, "path" | "head" | "updatedAt"> & { markdown: string | null })[]> {
  const rows = await rendererDb()<
    { path: string; head: PageHead; updated_at: Date; markdown: string | null }[]
  >`
    select path, head, updated_at, markdown
    from content.published_pages
    where site_id = ${siteId}::uuid and markdown is not null
    order by updated_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    path: r.path,
    head: r.head ?? {},
    updatedAt: r.updated_at,
    markdown: r.markdown,
  }));
}
