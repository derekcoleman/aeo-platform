import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { buildPublishedPage } from "@/lib/pipeline/publish";
import { defaultAuthor, loadSources } from "@/lib/pipeline/versions";
import { renderArticleDocument } from "@/lib/render/document";
import type { PublishedPage } from "@/lib/render/published";
import type { SiteRenderConfig } from "@/lib/render/site-config";
import { sanitiseCustomCss, type SiteTheme } from "@/lib/render/theme";
import { sanitizeFragment } from "@/lib/render/sanitize";
import { toSiteRoute } from "@/lib/tenancy/store";
import type { SiteRoute } from "@/lib/tenancy/types";
import { loadVersionDetail, type VersionDetail } from "./content";

/**
 * Themed previews for the app plane: exactly the document the render path
 * would serve, built from a content version (or a sample article) and the
 * site's render config, through the service connection rather than the
 * renderer role. Never indexable, never on the customer's domain.
 */

export async function loadRenderConfig(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteRenderConfig | null> {
  const [row] = await sql<{ site_id: string; canonical_domain: string; path_prefix: string; locale: string; trailing_slash: "never" | "always"; theme: SiteTheme; organization: SiteRenderConfig["organization"] }[]>`
    select site_id, canonical_domain, path_prefix, locale, trailing_slash, theme, organization from content.site_render_config where site_id = ${siteId}`;
  if (!row) return null;
  return { siteId: row.site_id, canonicalDomain: row.canonical_domain, pathPrefix: row.path_prefix, locale: row.locale, trailingSlash: row.trailing_slash, theme: row.theme ?? { tokens: {} }, organization: row.organization ?? {} };
}

export async function loadSiteRouteApp(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteRoute | null> {
  const [row] = await sql<Parameters<typeof toSiteRoute>[0][]>`
    select s.id, s.org_id, s.canonical_domain, s.path_prefix, s.edge_hostname, s.proxy_mode, s.trailing_slash, s.locale, s.status,
           (select coalesce(json_agg(json_build_object('hostname', d.hostname)), '[]'::json) from app.site_domains d where d.site_id = s.id) as site_domains
    from app.sites s where s.id = ${siteId}`;
  return row ? toSiteRoute(row) : null;
}

/** Theme values are untrusted even from ops: same sanitisers as the renderer, applied before storage and before preview. */
export function normaliseTheme(input: SiteTheme): SiteTheme {
  const tokens: SiteTheme["tokens"] = {};
  for (const [k, v] of Object.entries(input.tokens ?? {})) {
    if (typeof v !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(k)) continue;
    const clean = v.trim();
    if (clean) tokens[k] = clean;
  }
  return {
    tokens,
    headerHtml: input.headerHtml ? sanitizeFragment(input.headerHtml) : null,
    footerHtml: input.footerHtml ? sanitizeFragment(input.footerHtml) : null,
    customCss: input.customCss ? sanitiseCustomCss(input.customCss).slice(0, 20_000) : null,
  };
}

const SAMPLE_MD = `Single sign-on (SSO) lets people log in once; SCIM keeps their accounts in step afterwards. Most teams need both, in that order.

## What does SSO actually do?

SSO delegates authentication to an identity provider so a person signs in once and reaches every connected app. It does not create, update or remove accounts.

## What does SCIM add?

SCIM provisions and deprovisions users automatically from the identity provider, which is what closes the gap when someone leaves.

## Which one first?

SSO first, because it removes password sprawl immediately; SCIM second, once the directory is the source of truth.`;

const SAMPLE_HTML = SAMPLE_MD.split("\n\n")
  .map((block) => (block.startsWith("## ") ? `<h2>${block.slice(3)}</h2>` : `<p>${block}</p>`))
  .join("\n");

export interface PreviewOptions {
  themeOverride?: SiteTheme | null;
}

async function documentFor(version: VersionDetail | null, siteId: string, opts: PreviewOptions, sql: postgres.Sql): Promise<string | null> {
  const [config, site, author] = await Promise.all([loadRenderConfig(siteId, sql), loadSiteRouteApp(siteId, sql), defaultAuthor(siteId, sql)]);
  if (!config || !site) return null;
  const effectiveConfig: SiteRenderConfig = opts.themeOverride ? { ...config, theme: normaliseTheme(opts.themeOverride) } : config;
  const sources = version ? await loadSources(version.id, sql) : [];
  const faq = version ? ((version.frontmatter as { faq?: { question: string; answer: string }[] }).faq ?? []) : [];
  const slug = version?.slug ?? "sso-vs-scim-sample";
  const built = buildPublishedPage({
    site,
    organization: config.organization,
    slug,
    title: version?.title ?? "SSO vs SCIM: which does a mid-market team need first?",
    description: version?.description ?? "A sample article rendered in this site's theme.",
    bodyHtml: version?.body_html ?? SAMPLE_HTML,
    bodyMd: version?.body_md ?? SAMPLE_MD,
    author,
    citations: sources.map((s) => ({ url: s.url, publisher: (s as { publisher?: string | null }).publisher ?? null, title: (s as { title?: string | null }).title ?? null })),
    faq,
    datePublished: version ? new Date(version.created_at) : new Date(),
  });
  const page: PublishedPage = {
    siteId,
    path: built.path,
    contentItemId: version?.content_item_id ?? null,
    html: built.html,
    head: { ...built.head, noindex: true },
    markdown: built.markdown,
    etag: built.etag,
    updatedAt: new Date(),
  };
  return renderArticleDocument({ config: effectiveConfig, host: { canonicalDomain: site.canonicalDomain, indexable: false, reason: "site-not-active" }, page, slug });
}

/** The document for a specific version, or null when it does not exist. */
export async function previewVersionHtml(versionId: string, opts: PreviewOptions = {}, sql: postgres.Sql = appDb()): Promise<{ html: string; siteId: string; orgId: string } | null> {
  const version = await loadVersionDetail(versionId, sql);
  if (!version) return null;
  const html = await documentFor(version, version.site_id, opts, sql);
  return html ? { html, siteId: version.site_id, orgId: version.org_id } : null;
}

/** The site's latest version, or a sample article when it has none yet. */
export async function previewSiteHtml(siteId: string, opts: PreviewOptions = {}, sql: postgres.Sql = appDb()): Promise<string | null> {
  const [latest] = await sql<{ id: string }[]>`
    select v.id from content.content_versions v join content.content_items ci on ci.id = v.content_item_id
    where ci.site_id = ${siteId} order by v.created_at desc limit 1`;
  const version = latest ? await loadVersionDetail(latest.id, sql) : null;
  return documentFor(version, siteId, opts, sql);
}
