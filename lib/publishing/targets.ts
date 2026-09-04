import { createHash } from "node:crypto";
import type postgres from "postgres";
import { getConnection } from "@/lib/connectors/store";
import type { ConnectorContext } from "@/lib/connectors/types";
import { articleFieldData, webflowClientFor, type FieldMap } from "@/lib/connectors/webflow";
import { appDb } from "@/lib/db/app";
import { escapeHtml } from "@/lib/render/sanitize";

/**
 * Publish targets: where a site's published content goes beyond the proxy.
 * One row per destination; one external_publications row per (target, item)
 * remembering the external id so a re-publish updates in place instead of
 * creating a duplicate post.
 */

export interface WebflowTargetConfig {
  siteId: string;
  siteName: string;
  collectionId: string;
  collectionName: string;
  fieldMap: FieldMap;
  /** Publish the item live after creating/updating it; false leaves it staged in Webflow. */
  publishLive: boolean;
  /** Which copy is canonical when the proxy also serves the article. */
  canonicalMode: "proxy" | "webflow" | "none";
  /** Push every newly published item automatically. */
  autoPush: boolean;
}

export interface PublishTargetRow {
  id: string;
  org_id: string;
  site_id: string;
  kind: "proxy" | "webflow";
  connection_id: string | null;
  name: string;
  config: WebflowTargetConfig;
  enabled: boolean;
  created_at: string | Date;
}

export async function listPublishTargets(siteId: string, sql: postgres.Sql = appDb()): Promise<PublishTargetRow[]> {
  return sql<PublishTargetRow[]>`select id, org_id, site_id, kind, connection_id, name, config, enabled, created_at from content.publish_targets where site_id = ${siteId} order by created_at`;
}

export async function loadPublishTarget(targetId: string, sql: postgres.Sql = appDb()): Promise<PublishTargetRow | null> {
  const [row] = await sql<PublishTargetRow[]>`select id, org_id, site_id, kind, connection_id, name, config, enabled, created_at from content.publish_targets where id = ${targetId}`;
  return row ?? null;
}

export async function createWebflowTarget(siteId: string, connectionId: string, name: string, config: WebflowTargetConfig, sql: postgres.Sql = appDb()): Promise<PublishTargetRow> {
  const [row] = await sql<PublishTargetRow[]>`
    insert into content.publish_targets (site_id, kind, connection_id, name, config)
    values (${siteId}, 'webflow', ${connectionId}, ${name}, ${sql.json(config as never)})
    returning id, org_id, site_id, kind, connection_id, name, config, enabled, created_at`;
  if (!row) throw new Error("publish target insert returned no row");
  return row;
}

export async function updatePublishTarget(targetId: string, patch: { name?: string; config?: WebflowTargetConfig; enabled?: boolean }, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update content.publish_targets set
    name = coalesce(${patch.name ?? null}, name),
    config = coalesce(${patch.config ? sql.json(patch.config as never) : null}, config),
    enabled = coalesce(${patch.enabled ?? null}::boolean, enabled),
    updated_at = now() where id = ${targetId}`;
}

export async function deletePublishTarget(targetId: string, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`delete from content.publish_targets where id = ${targetId}`;
}

export interface ExternalPublicationRow {
  id: string;
  content_item_id: string;
  target_id: string;
  target_name: string;
  status: "pending" | "published" | "failed" | "removed";
  external_id: string | null;
  external_url: string | null;
  last_error: string | null;
  attempts: number;
  published_at: string | Date | null;
  updated_at: string | Date;
}

export async function listExternalPublications(siteId: string, sql: postgres.Sql = appDb()): Promise<ExternalPublicationRow[]> {
  return sql<ExternalPublicationRow[]>`
    select e.id, e.content_item_id, e.target_id, t.name as target_name, e.status, e.external_id, e.external_url, e.last_error, e.attempts, e.published_at, e.updated_at
    from content.external_publications e join content.publish_targets t on t.id = e.target_id
    where e.site_id = ${siteId} order by e.updated_at desc`;
}

// ── the push ────────────────────────────────────────────────────────────────

export interface ArticleSource {
  id: string;
  site_id: string;
  slug: string;
  title: string;
  description: string | null;
  body_html: string;
  faq: { question: string; answer: string }[];
  published_at: Date | null;
  canonical_url: string | null;
  author_name: string | null;
  version_id: string | null;
}

export async function loadArticleForPush(contentItemId: string, sql: postgres.Sql = appDb()): Promise<ArticleSource | null> {
  const [row] = await sql<{ id: string; site_id: string; slug: string; title: string; description: string | null; body_html: string; frontmatter: { faq?: { question: string; answer: string }[] } | null; published_at: Date | null; canonical_url: string | null; author_name: string | null; version_id: string | null }[]>`
    select ci.id, ci.site_id, ci.slug, coalesce(v.title, ci.title, ci.slug) as title, v.description, v.body_html, v.frontmatter, ci.published_at, ci.canonical_url,
           a.name as author_name, v.id as version_id
    from content.content_items ci
    left join content.content_versions v on v.id = ci.current_version_id
    left join content.authors a on a.id = ci.author_id
    where ci.id = ${contentItemId}`;
  if (!row || !row.body_html) return null;
  return { ...row, faq: row.frontmatter?.faq ?? [] };
}

/** The body Webflow gets: the sanitised article HTML plus the FAQ as headings, so the post is complete without our renderer. */
export function webflowBodyHtml(a: Pick<ArticleSource, "body_html" | "faq">): string {
  if (!a.faq.length) return a.body_html;
  const faq = a.faq.map((f) => `<h3>${escapeHtml(f.question)}</h3><p>${escapeHtml(f.answer)}</p>`).join("");
  return `${a.body_html}<h2>Frequently asked questions</h2>${faq}`;
}

export function payloadHash(fieldData: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(fieldData)).digest("hex").slice(0, 32);
}

export interface PushResult {
  ok: boolean;
  skipped?: string;
  externalId?: string;
  externalUrl?: string | null;
  error?: string;
}

/** Create or update the item in the target's collection, publish it live when asked, and record the outcome. Idempotent on payload. */
export async function pushItemToTarget(contentItemId: string, target: PublishTargetRow, ctx: ConnectorContext, opts: { force?: boolean } = {}): Promise<PushResult> {
  const sql = ctx.sql;
  if (target.kind !== "webflow") return { ok: false, skipped: `target kind ${target.kind} needs no push` };
  if (!target.enabled) return { ok: false, skipped: "target disabled" };
  const article = await loadArticleForPush(contentItemId, sql);
  if (!article) return { ok: false, error: "content item has no current version" };
  const conn = target.connection_id ? await getConnection(target.connection_id, sql) : null;
  if (!conn || conn.status !== "active") return await recordFailure(sql, target, article, "webflow connection is missing or inactive");

  const cfg = target.config;
  const fieldData = articleFieldData(
    { title: article.title, slug: article.slug, bodyHtml: webflowBodyHtml(article), summary: article.description, publishedAt: article.published_at ?? ctx.now(), canonicalUrl: article.canonical_url, authorName: article.author_name },
    cfg.fieldMap,
    { canonicalMode: cfg.canonicalMode },
  );
  const hash = payloadHash(fieldData);
  const [existing] = await sql<{ id: string; external_id: string | null; payload_hash: string | null; status: string }[]>`
    select id, external_id, payload_hash, status from content.external_publications where target_id = ${target.id} and content_item_id = ${contentItemId}`;
  if (!opts.force && existing?.status === "published" && existing.payload_hash === hash && existing.external_id) {
    return { ok: true, skipped: "unchanged", externalId: existing.external_id };
  }

  try {
    const api = await webflowClientFor(conn, ctx);
    const item = existing?.external_id
      ? await api.updateItem(cfg.collectionId, existing.external_id, { fieldData, isDraft: !cfg.publishLive })
      : await api.createItem(cfg.collectionId, { fieldData, isDraft: !cfg.publishLive });
    if (cfg.publishLive) await api.publishItems(cfg.collectionId, [item.id]);
    const slug = String(fieldData[cfg.fieldMap.slug] ?? article.slug);
    const externalUrl = cfg.publishLive ? guessItemUrl(cfg, slug) : null;
    await sql`
      insert into content.external_publications (site_id, content_item_id, target_id, status, external_id, external_url, version_id, payload_hash, attempts, published_at, last_error, updated_at)
      values (${article.site_id}, ${contentItemId}, ${target.id}, 'published', ${item.id}, ${externalUrl}, ${article.version_id}, ${hash}, 1, ${ctx.now()}, null, ${ctx.now()})
      on conflict (target_id, content_item_id) do update set
        status = 'published', external_id = excluded.external_id, external_url = excluded.external_url, version_id = excluded.version_id,
        payload_hash = excluded.payload_hash, attempts = content.external_publications.attempts + 1, published_at = excluded.published_at, last_error = null, updated_at = excluded.updated_at`;
    return { ok: true, externalId: item.id, externalUrl };
  } catch (e) {
    return recordFailure(sql, target, article, e instanceof Error ? e.message : String(e));
  }
}

async function recordFailure(sql: postgres.Sql, target: PublishTargetRow, article: ArticleSource, error: string): Promise<PushResult> {
  await sql`
    insert into content.external_publications (site_id, content_item_id, target_id, status, version_id, attempts, last_error, updated_at)
    values (${article.site_id}, ${article.id}, ${target.id}, 'failed', ${article.version_id}, 1, ${error.slice(0, 500)}, now())
    on conflict (target_id, content_item_id) do update set
      status = 'failed', attempts = content.external_publications.attempts + 1, last_error = excluded.last_error, updated_at = now()`;
  return { ok: false, error };
}

/** Webflow does not return the public URL; collection pages live at /<collection slug>/<item slug> on the site's domain when the site publishes. */
function guessItemUrl(cfg: WebflowTargetConfig, slug: string): string | null {
  const domain = (cfg as WebflowTargetConfig & { publicDomain?: string }).publicDomain;
  const collectionSlug = (cfg as WebflowTargetConfig & { collectionSlug?: string }).collectionSlug;
  if (!domain || !collectionSlug) return null;
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/${collectionSlug}/${slug}`;
}

/** Every enabled auto-push target for the item's site. */
export async function pushItemEverywhere(contentItemId: string, siteId: string, ctx: ConnectorContext, opts: { force?: boolean; onlyAuto?: boolean } = {}): Promise<{ targetId: string; result: PushResult }[]> {
  const targets = (await listPublishTargets(siteId, ctx.sql)).filter((t) => t.enabled && t.kind === "webflow" && (!opts.onlyAuto || t.config.autoPush !== false));
  const out: { targetId: string; result: PushResult }[] = [];
  for (const t of targets) out.push({ targetId: t.id, result: await pushItemToTarget(contentItemId, t, ctx, opts) });
  return out;
}
