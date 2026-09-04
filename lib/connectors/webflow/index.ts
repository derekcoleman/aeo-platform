import type { Connector, ConnectorContext, ConnectionRow, SyncResult } from "../types";
import { ConnectorError } from "../types";
import { WebflowApi, type WebflowField } from "./api";

export * from "./api";

/**
 * Webflow: a publishing destination, not a context source. The connection
 * holds a site API token (Vault) and remembers which Webflow sites the token
 * can see. Publish targets (content.publish_targets) point at a collection
 * with a field map; the pipeline pushes through lib/publishing.
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
  async sync(input): Promise<SyncResult> {
    return { documentsIngested: 0, metricsIngested: 0, cursor: input.cursor, detail: { skipped: "webflow is a publish target; nothing to pull" } };
  },
};

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
