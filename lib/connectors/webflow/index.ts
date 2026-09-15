import { loadSiteOwnership } from "@/lib/demand/store";
import { cmsItemFromWebflow, linkCmsItemsToContent, markMissingCmsItems, pickPublicDomain, upsertCmsItems } from "@/lib/refresh/inventory";
import type { Connector, ConnectorContext, ConnectionRow, SyncResult } from "../types";
import { ConnectorError } from "../types";
import { WebflowApi, type WebflowField } from "./api";

export * from "./api";

/**
 * Webflow: a publishing destination and the source of the CMS inventory. The
 * connection holds a site API token (Vault) and remembers which Webflow sites
 * the token can see. Publish targets (content.publish_targets) point at a
 * collection with a field map; the pipeline pushes through lib/publishing.
 * The daily sync pulls every collection into content.cms_items so the
 * refresh scan can see what already exists, when it last changed, and how it
 * performs.
 */

export interface WebflowConfig {
  sites?: { id: string; name: string }[];
  /** Cached so the target editor does not round-trip on every render. */
  checkedAt?: string;
}

export const webflowConnector: Connector<WebflowConfig> = {
  provider: "webflow",
  async validate(conn, ctx) {
    const api = await webflowClientFor(conn, ctx);
    const sites = await api.sites();
    if (sites.length === 0) throw new ConnectorError("webflow", "no_sites", "webflow: the token can see no sites; create it under the site's Apps & integrations with cms:read and cms:write");
  },
  async sync(input, ctx): Promise<SyncResult> {
    if (input.kind === "webhook" || input.kind === "upload") return { documentsIngested: 0, metricsIngested: 0, cursor: input.cursor, detail: { skipped: `kind ${input.kind}` } };
    const summary = await syncWebflowInventory(input.connection, ctx);
    return { documentsIngested: summary.items, metricsIngested: 0, cursor: { through: ctx.now().toISOString() }, detail: { inventory: summary } };
  },
};

export const MAX_SITES_PER_SYNC = 5;
export const MAX_COLLECTIONS_PER_SITE = 40;

export interface InventorySyncSummary {
  sites: number;
  collections: number;
  items: number;
  written: number;
  missing: number;
  linked: number;
  skipped: { collection: string; reason: string }[];
}

/**
 * Pull every collection of every site the token can see into content.cms_items.
 * The collection's field map is suggested the same way the publish target
 * editor does it, so the body we read is the body a refresh will write back.
 */
export async function syncWebflowInventory(conn: ConnectionRow<WebflowConfig>, ctx: ConnectorContext): Promise<InventorySyncSummary> {
  if (!conn.site_id) throw new ConnectorError("webflow", "site_required", "webflow: inventory needs a site-scoped connection");
  const own = await loadSiteOwnership(conn.site_id, ctx.sql);
  if (!own) throw new ConnectorError("webflow", "site_not_found");
  const api = await webflowClientFor(conn, ctx);
  const siteConn = conn as ConnectionRow<WebflowConfig> & { site_id: string };
  const now = ctx.now();
  const summary: InventorySyncSummary = { sites: 0, collections: 0, items: 0, written: 0, missing: 0, linked: 0, skipped: [] };

  const sites = (await api.sites()).slice(0, MAX_SITES_PER_SYNC);
  for (const site of sites) {
    summary.sites += 1;
    const domain = pickPublicDomain(site, own.domains);
    const collections = (await api.collections(site.id)).slice(0, MAX_COLLECTIONS_PER_SITE);
    for (const c of collections) {
      let detail;
      try {
        detail = await api.collection(c.id);
      } catch (e) {
        summary.skipped.push({ collection: c.displayName, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const map = suggestFieldMap(detail.fields);
      const items = await api.listAllItems(c.id);
      const rows = items.map((i) => cmsItemFromWebflow(i, detail, map, site.id, domain));
      summary.collections += 1;
      summary.items += rows.length;
      summary.written += await upsertCmsItems(siteConn, rows, now, ctx.sql);
      summary.missing += await markMissingCmsItems(conn.id, c.id, rows.map((r) => r.externalId), now, ctx.sql);
    }
  }
  summary.linked = await linkCmsItemsToContent(conn.site_id, ctx.sql);
  return summary;
}

export async function webflowClientFor(conn: Pick<ConnectionRow, "secret_ref">, ctx: Pick<ConnectorContext, "secrets" | "fetchImpl" | "env">): Promise<WebflowApi> {
  if (!conn.secret_ref) throw new ConnectorError("webflow", "no_token", "webflow: connection has no token");
  const token = await ctx.secrets.get(conn.secret_ref);
  if (!token) throw new ConnectorError("webflow", "token_missing", "webflow: token not found in Vault");
  return new WebflowApi(token, ctx.fetchImpl, ctx.env.WEBFLOW_API_BASE || undefined);
}

// ── field mapping ───────────────────────────────────────────────────────────

export interface FieldMap {
  name: string;
  slug: string;
  body: string;
  summary?: string | null;
  image?: string | null;
  publishedAt?: string | null;
  canonical?: string | null;
  author?: string | null;
}

const has = (f: WebflowField, ...words: string[]) => words.some((w) => f.slug.toLowerCase().includes(w) || f.displayName.toLowerCase().includes(w));

/** Best guess from the collection's fields; the editor lets the user override every slot. */
export function suggestFieldMap(fields: WebflowField[]): FieldMap {
  const editable = fields.filter((f) => f.isEditable);
  const byType = (t: string) => editable.filter((f) => f.type.toLowerCase() === t.toLowerCase());
  const rich = byType("RichText");
  const plain = [...byType("PlainText"), ...byType("Text")];
  const body = rich.find((f) => has(f, "body", "content", "post", "article")) ?? rich[0] ?? null;
  const summary = plain.find((f) => has(f, "summary", "excerpt", "description", "intro", "teaser")) ?? null;
  const image = byType("Image").find((f) => has(f, "main", "hero", "thumb", "cover", "featured")) ?? byType("Image")[0] ?? null;
  const publishedAt = byType("DateTime").find((f) => has(f, "publish", "date", "posted")) ?? null;
  const canonical = [...plain, ...byType("Link")].find((f) => has(f, "canonical")) ?? null;
  const author = plain.find((f) => has(f, "author", "byline")) ?? null;
  return {
    name: fields.find((f) => f.slug === "name")?.slug ?? "name",
    slug: fields.find((f) => f.slug === "slug")?.slug ?? "slug",
    body: body?.slug ?? "",
    summary: summary?.slug ?? null,
    image: image?.slug ?? null,
    publishedAt: publishedAt?.slug ?? null,
    canonical: canonical?.slug ?? null,
    author: author?.slug ?? null,
  };
}

export interface ArticleForWebflow {
  title: string;
  slug: string;
  bodyHtml: string;
  summary: string | null;
  imageUrl?: string | null;
  publishedAt: Date;
  canonicalUrl: string | null;
  authorName?: string | null;
}

/** Item fieldData for a collection. Unmapped slots are omitted; nothing is invented. */
export function articleFieldData(a: ArticleForWebflow, map: FieldMap, opts: { canonicalMode: "proxy" | "webflow" | "none" }): Record<string, unknown> {
  if (!map.body) throw new ConnectorError("webflow", "no_body_field", "webflow: the field map has no rich-text body field");
  const data: Record<string, unknown> = {
    [map.name]: a.title.slice(0, 256),
    [map.slug]: a.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200) || "post",
    [map.body]: a.bodyHtml,
  };
  if (map.summary && a.summary) data[map.summary] = a.summary.slice(0, 1000);
  if (map.image && a.imageUrl) data[map.image] = { url: a.imageUrl };
  if (map.publishedAt) data[map.publishedAt] = a.publishedAt.toISOString();
  if (map.author && a.authorName) data[map.author] = a.authorName;
  if (map.canonical && opts.canonicalMode === "proxy" && a.canonicalUrl) data[map.canonical] = a.canonicalUrl;
  return data;
}
