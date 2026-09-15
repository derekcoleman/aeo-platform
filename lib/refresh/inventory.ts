import * as cheerio from "cheerio";
import type postgres from "postgres";
import type { ConnectionRow } from "@/lib/connectors/types";
import type { WebflowItem, WebflowSite } from "@/lib/connectors/webflow/api";
import type { FieldMap } from "@/lib/connectors/webflow";
import { appDb } from "@/lib/db/app";
import { stripWww } from "@/lib/demand/store";

/**
 * The CMS inventory: every item the Webflow token can see, across every
 * collection, with the collection it lives in, when it was last modified and
 * last published, and its body. It is the "what already exists" half of the
 * refresh loop; the scan (./scan.ts) joins it with Search Console traffic and
 * AI citations to decide what is worth updating.
 *
 * Items are never deleted here: one that a sync no longer sees is marked
 * `missing_since` so history (and any refresh in flight) survives. The pull
 * itself lives with the Webflow connector (syncWebflowInventory); this module
 * is the pure mapping and the persistence.
 */

export interface CmsItemInput {
  externalSiteId: string;
  collectionId: string;
  collectionName: string;
  collectionSlug: string;
  externalId: string;
  slug: string | null;
  title: string | null;
  url: string | null;
  bodyHtml: string | null;
  summary: string | null;
  wordCount: number;
  headingCount: number;
  isDraft: boolean;
  isArchived: boolean;
  createdOn: string | null;
  lastUpdated: string | null;
  lastPublished: string | null;
  fieldMap: FieldMap;
}

/** `https://www.Acme.com/blog/x/?utm=1` → `acme.com/blog/x`: what GSC pages and cited URLs are joined on. */
export function urlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${stripWww(u.hostname)}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The domain a Webflow site's collection pages are served from: the custom
 * domain that is one of ours when there is one (that is the site GSC and the
 * trackers know), else the first custom domain, else the webflow.io staging
 * host.
 */
export function pickPublicDomain(site: Pick<WebflowSite, "customDomains" | "shortName">, ownDomains: string[]): string | null {
  const own = new Set(ownDomains.map(stripWww));
  const clean = site.customDomains.map((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
  const owned = clean.find((d) => own.has(stripWww(d)) || [...own].some((o) => stripWww(d).endsWith(`.${o}`)));
  if (owned) return owned;
  if (clean[0]) return clean[0];
  return site.shortName ? `${site.shortName}.webflow.io` : null;
}

/** Collection pages live at /<collection slug>/<item slug> on the site's domain. */
export function webflowItemUrl(domain: string | null, collectionSlug: string, slug: string | null): string | null {
  if (!domain || !collectionSlug || !slug) return null;
  return `https://${domain.replace(/\/$/, "")}/${collectionSlug}/${slug}`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Word and heading counts of a rich-text body, computed the same way for every item. */
export function measureBody(html: string | null): { wordCount: number; headingCount: number } {
  if (!html) return { wordCount: 0, headingCount: 0 };
  // Block boundaries become whitespace so "<h2>Why</h2><p>one" is two words, not one.
  const $ = cheerio.load(html.replace(/<\/(p|h[1-6]|li|div|blockquote|td|th|tr|figcaption|pre)>|<br\s*\/?>/gi, "$& "), null, false);
  const text = $.root().text();
  return { wordCount: text.split(/\s+/).filter(Boolean).length, headingCount: $("h2, h3").length };
}

/** One Webflow item → an inventory row, reading title / slug / body / summary through the collection's field map. */
export function cmsItemFromWebflow(
  item: WebflowItem,
  collection: { id: string; displayName: string; slug: string },
  map: FieldMap,
  externalSiteId: string,
  domain: string | null,
): CmsItemInput {
  const f = item.fieldData;
  const slug = str(f[map.slug]) ?? str(f.slug);
  const bodyHtml = map.body ? str(f[map.body]) : null;
  const { wordCount, headingCount } = measureBody(bodyHtml);
  return {
    externalSiteId,
    collectionId: collection.id,
    collectionName: collection.displayName,
    collectionSlug: collection.slug,
    externalId: item.id,
    slug,
    title: str(f[map.name]) ?? str(f.name),
    url: webflowItemUrl(domain, collection.slug, slug),
    bodyHtml,
    summary: map.summary ? str(f[map.summary])?.slice(0, 1000) ?? null : null,
    wordCount,
    headingCount,
    isDraft: item.isDraft,
    isArchived: item.isArchived,
    createdOn: item.createdOn ?? null,
    lastUpdated: item.lastUpdated ?? null,
    lastPublished: item.lastPublished ?? null,
    fieldMap: map,
  };
}

export async function upsertCmsItems(conn: Pick<ConnectionRow, "id" | "org_id"> & { site_id: string }, rows: CmsItemInput[], now: Date, sql: postgres.Sql = appDb()): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const res = await sql`
      insert into content.cms_items
        (org_id, site_id, connection_id, provider, external_site_id, collection_id, collection_name, collection_slug, external_id,
         slug, title, url, url_key, body_html, summary, word_count, heading_count, is_draft, is_archived,
         created_on, last_updated, last_published, field_map, first_seen_at, last_seen_at, missing_since, updated_at)
      values (${conn.org_id}, ${conn.site_id}, ${conn.id}, 'webflow', ${r.externalSiteId}, ${r.collectionId}, ${r.collectionName}, ${r.collectionSlug}, ${r.externalId},
              ${r.slug}, ${r.title}, ${r.url}, ${urlKey(r.url)}, ${r.bodyHtml}, ${r.summary}, ${r.wordCount}, ${r.headingCount}, ${r.isDraft}, ${r.isArchived},
              ${r.createdOn ? new Date(r.createdOn) : null}, ${r.lastUpdated ? new Date(r.lastUpdated) : null}, ${r.lastPublished ? new Date(r.lastPublished) : null},
              ${sql.json(r.fieldMap as never)}, ${now}, ${now}, null, ${now})
      on conflict (connection_id, collection_id, external_id) do update set
        collection_name = excluded.collection_name, collection_slug = excluded.collection_slug,
        slug = excluded.slug, title = excluded.title, url = excluded.url, url_key = excluded.url_key,
        body_html = excluded.body_html, summary = excluded.summary, word_count = excluded.word_count, heading_count = excluded.heading_count,
        is_draft = excluded.is_draft, is_archived = excluded.is_archived,
        created_on = excluded.created_on, last_updated = excluded.last_updated, last_published = excluded.last_published,
        field_map = excluded.field_map, last_seen_at = excluded.last_seen_at, missing_since = null, updated_at = excluded.updated_at
      returning id`;
    written += res.length;
  }
  return written;
}

/** Items of a collection the sync did not see this time were deleted in the CMS; flag them, keep the rows. */
export async function markMissingCmsItems(connectionId: string, collectionId: string, seenExternalIds: string[], now: Date, sql: postgres.Sql = appDb()): Promise<number> {
  const rows = await sql`
    update content.cms_items set missing_since = coalesce(missing_since, ${now}), updated_at = ${now}
    where connection_id = ${connectionId} and collection_id = ${collectionId} and missing_since is null
      and not (external_id = any (${seenExternalIds}::text[]))
    returning id`;
  return rows.length;
}

/** Items we pushed there ourselves carry our content item id via the external_publications ledger. */
export async function linkCmsItemsToContent(siteId: string, sql: postgres.Sql = appDb()): Promise<number> {
  const rows = await sql`
    update content.cms_items c set content_item_id = e.content_item_id, updated_at = now()
    from content.external_publications e join content.publish_targets t on t.id = e.target_id
    where c.site_id = ${siteId} and c.content_item_id is null and e.external_id is not null
      and t.connection_id = c.connection_id and t.config->>'collectionId' = c.collection_id and e.external_id = c.external_id
    returning c.id`;
  return rows.length;
}
