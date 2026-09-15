import type postgres from "postgres";
import { htmlToMarkdown } from "@/lib/audit/html";
import { getConnection } from "@/lib/connectors/store";
import type { ConnectorContext } from "@/lib/connectors/types";
import { webflowClientFor, type FieldMap } from "@/lib/connectors/webflow";
import { appDb } from "@/lib/db/app";
import { slugify } from "@/lib/pipeline/draft";
import { createContentItem, reserveSlug } from "@/lib/pipeline/versions";
import { webflowBodyHtml } from "@/lib/publishing/targets";

/**
 * Refreshing a post that already lives in the customer's CMS.
 *
 * The item is imported as a cms-origin content item so the pipeline can run
 * brief → draft → QA → approval against it like anything else; the existing
 * body is handed to the brief and the draft as the thing to improve. When
 * the refreshed version is approved it is PATCHed onto the same Webflow item
 * — same id, same slug, same URL — and published if the post was live. It is
 * never materialised into published_pages: the CMS URL is its home, and a
 * second copy under the proxy prefix would be a duplicate.
 */

export interface CmsItemRow {
  id: string;
  org_id: string;
  site_id: string;
  connection_id: string;
  collection_id: string;
  collection_name: string;
  external_id: string;
  slug: string | null;
  title: string | null;
  url: string | null;
  body_html: string | null;
  summary: string | null;
  word_count: number;
  is_draft: boolean;
  is_archived: boolean;
  last_updated: Date | null;
  last_published: Date | null;
  field_map: FieldMap;
  content_item_id: string | null;
  refresh_reasons: string[];
}

const CMS_COLUMNS = "id, org_id, site_id, connection_id, collection_id, collection_name, external_id, slug, title, url, body_html, summary, word_count, is_draft, is_archived, last_updated, last_published, field_map, content_item_id, refresh_reasons";

export async function loadCmsItem(id: string, sql: postgres.Sql = appDb()): Promise<CmsItemRow | null> {
  const [row] = await sql<CmsItemRow[]>`select ${sql.unsafe(CMS_COLUMNS)} from content.cms_items where id = ${id}`;
  return row ?? null;
}

export async function loadCmsItemForContent(contentItemId: string, sql: postgres.Sql = appDb()): Promise<CmsItemRow | null> {
  const [row] = await sql<CmsItemRow[]>`select ${sql.unsafe(CMS_COLUMNS)} from content.cms_items where content_item_id = ${contentItemId} order by last_seen_at desc limit 1`;
  return row ?? null;
}

/** What the brief and the draft see of the existing post. Markdown so the model reads structure, not tags. */
export interface ExistingContent {
  title: string;
  url: string | null;
  description: string | null;
  bodyMd: string;
  wordCount: number;
  lastUpdated: string | null;
  reasons: string[];
}

export const EXISTING_BODY_MAX_CHARS = 16_000;

export function existingContentFromCms(item: CmsItemRow): ExistingContent {
  return {
    title: item.title ?? item.slug ?? "Untitled",
    url: item.url,
    description: item.summary,
    bodyMd: htmlToMarkdown(item.body_html ?? "", EXISTING_BODY_MAX_CHARS),
    wordCount: item.word_count,
    lastUpdated: item.last_updated ? new Date(item.last_updated).toISOString().slice(0, 10) : null,
    reasons: item.refresh_reasons ?? [],
  };
}

/**
 * The existing article for a refresh opportunity: the CMS item named in the
 * evidence, else the CMS item linked to the content item, else our own
 * current version (a post-publish refresh of a proxy-served article).
 */
export async function loadExistingContent(
  opp: { content_item_id?: string | null; evidence: Record<string, unknown> },
  sql: postgres.Sql = appDb(),
): Promise<ExistingContent | null> {
  const cmsItemId = typeof opp.evidence.cmsItemId === "string" ? opp.evidence.cmsItemId : null;
  const cms = cmsItemId ? await loadCmsItem(cmsItemId, sql) : opp.content_item_id ? await loadCmsItemForContent(opp.content_item_id, sql) : null;
  if (cms) return existingContentFromCms(cms);
  if (!opp.content_item_id) return null;
  const [v] = await sql<{ title: string; description: string | null; body_md: string; word_count: number; canonical_url: string | null; published_at: Date | null }[]>`
    select v.title, v.description, v.body_md, v.word_count, ci.canonical_url, ci.published_at
    from content.content_items ci join content.content_versions v on v.id = ci.current_version_id
    where ci.id = ${opp.content_item_id}`;
  if (!v) return null;
  const reasons = Array.isArray(opp.evidence.reasons) ? (opp.evidence.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [];
  return {
    title: v.title,
    url: v.canonical_url,
    description: v.description,
    bodyMd: v.body_md.replace(/\{\{\s*(?:src|fact):[a-z0-9][a-z0-9-]{1,63}\s*\}\}/g, "").slice(0, EXISTING_BODY_MAX_CHARS),
    wordCount: v.word_count,
    lastUpdated: v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : null,
    reasons,
  };
}

/**
 * Create the cms-origin content item for an inventory row (once). The slug is
 * internal — the post keeps its CMS slug — so a clash with one of our own
 * articles just gets a suffix.
 */
export async function importCmsItem(cmsItemId: string, opts: { opportunityId: string | null; authorId: string | null }, sql: postgres.Sql = appDb()): Promise<{ id: string; slug: string; imported: boolean }> {
  const item = await loadCmsItem(cmsItemId, sql);
  if (!item) throw new Error(`cms item ${cmsItemId} not found`);
  if (item.content_item_id) {
    const [existing] = await sql<{ id: string; slug: string }[]>`select id, slug from content.content_items where id = ${item.content_item_id}`;
    if (existing) return { ...existing, imported: false };
  }
  const slug = await reserveSlug(item.site_id, slugify(item.slug ?? item.title ?? "post"), sql);
  const { id } = await createContentItem({ siteId: item.site_id, slug, title: item.title ?? slug, briefId: null, authorId: opts.authorId, opportunityId: opts.opportunityId, origin: "cms" }, sql);
  await sql`update content.cms_items set content_item_id = ${id}, updated_at = now() where id = ${cmsItemId}`;
  return { id, slug, imported: true };
}

/** Field data for the in-place update: title, body and summary through the collection's map. Never the slug. */
export function refreshFieldData(item: Pick<CmsItemRow, "field_map">, version: { title: string; description: string | null; bodyHtml: string; faq: { question: string; answer: string }[] }): Record<string, unknown> {
  const map = item.field_map;
  if (!map.body) throw new Error("cms item's collection has no rich-text body field");
  const data: Record<string, unknown> = {
    [map.name || "name"]: version.title.slice(0, 256),
    [map.body]: webflowBodyHtml({ body_html: version.bodyHtml, faq: version.faq }),
  };
  if (map.summary && version.description) data[map.summary] = version.description.slice(0, 1000);
  return data;
}

export interface CmsPublishResult {
  ok: boolean;
  externalId: string;
  url: string | null;
  publishedLive: boolean;
  error?: string;
}

/**
 * Flip the content item to published (current version, title, canonical =
 * the CMS URL) and PATCH the refreshed body onto the existing Webflow item.
 * The item goes live only if it was live before; a staged post stays staged.
 */
export async function publishRefreshToCms(input: { contentItemId: string; versionId: string; now?: Date }, ctx: ConnectorContext): Promise<CmsPublishResult> {
  const sql = ctx.sql;
  const now = input.now ?? ctx.now();
  const item = await loadCmsItemForContent(input.contentItemId, sql);
  if (!item) throw new Error(`content item ${input.contentItemId} is not linked to a cms item`);
  const [version] = await sql<{ title: string; description: string | null; body_html: string; frontmatter: { faq?: { question: string; answer: string }[] } | null }[]>`
    select title, description, body_html, frontmatter from content.content_versions where id = ${input.versionId}`;
  if (!version) throw new Error(`version ${input.versionId} not found`);
  const conn = await getConnection(item.connection_id, sql);
  if (!conn || conn.status !== "active") throw new Error("webflow connection is missing or inactive");

  const fieldData = refreshFieldData(item, { title: version.title, description: version.description, bodyHtml: version.body_html, faq: version.frontmatter?.faq ?? [] });
  const wasLive = !!item.last_published && !item.is_draft;
  const api = await webflowClientFor(conn, ctx);
  const updated = await api.updateItem(item.collection_id, item.external_id, { fieldData, isDraft: !wasLive });
  if (wasLive) await api.publishItems(item.collection_id, [updated.id]);

  await sql.begin(async (tx) => {
    await tx`
      update content.content_items set
        status = 'published', title = ${version.title}, current_version_id = ${input.versionId},
        canonical_url = ${item.url}, published_at = ${now}, first_published_at = coalesce(first_published_at, ${now}), updated_at = ${now}
      where id = ${input.contentItemId}`;
    await tx`
      update content.cms_items set
        title = ${version.title}, body_html = ${String(fieldData[item.field_map.body])}, summary = coalesce(${version.description}, summary),
        last_updated = ${now}, last_published = ${wasLive ? now : item.last_published}, last_refreshed_at = ${now}, updated_at = ${now}
      where id = ${item.id}`;
    // When the collection is also a publish target, the ledger row keeps the re-push button honest.
    await tx`
      insert into content.external_publications (site_id, content_item_id, target_id, status, external_id, external_url, version_id, attempts, published_at, last_error, updated_at)
      select ${item.site_id}, ${input.contentItemId}, t.id, 'published', ${item.external_id}, ${item.url}, ${input.versionId}, 1, ${now}, null, ${now}
      from content.publish_targets t
      where t.site_id = ${item.site_id} and t.connection_id = ${item.connection_id} and t.config->>'collectionId' = ${item.collection_id}
      on conflict (target_id, content_item_id) do update set
        status = 'published', external_id = excluded.external_id, external_url = excluded.external_url, version_id = excluded.version_id,
        attempts = content.external_publications.attempts + 1, published_at = excluded.published_at, last_error = null, updated_at = excluded.updated_at`;
  });
  return { ok: true, externalId: updated.id, url: item.url, publishedLive: wasLive };
}
