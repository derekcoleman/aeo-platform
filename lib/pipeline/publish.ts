import { createHash } from "node:crypto";
import { appDb } from "@/lib/db/app";
import type { PageHead } from "@/lib/render/published";
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
}

/** One transaction: published_pages upsert + content_items flip. A half-published item is not a state. */
export async function publishVersion(
  input: { contentItemId: string; versionId: string; siteId: string; page: BuiltPage; now?: Date },
  sql: postgres.Sql = appDb(),
): Promise<PublishResult> {
  const now = input.now ?? new Date();
  await sql.begin(async (tx) => {
    await tx`
      insert into content.published_pages (site_id, path, content_item_id, html, head, markdown, etag, updated_at)
      values (${input.siteId}, ${input.page.path}, ${input.contentItemId}, ${input.page.html}, ${tx.json(input.page.head as never)}, ${input.page.markdown}, ${input.page.etag}, ${now})
      on conflict (site_id, path) do update set
        content_item_id = excluded.content_item_id, html = excluded.html, head = excluded.head,
        markdown = excluded.markdown, etag = excluded.etag, updated_at = excluded.updated_at`;
    await tx`
      update content.content_items set
        status = 'published', title = ${input.page.head.title ?? null}, current_version_id = ${input.versionId},
        canonical_url = ${input.page.canonicalUrl}, published_at = ${now},
        first_published_at = coalesce(first_published_at, ${now}), updated_at = ${now}
      where id = ${input.contentItemId}`;
  });
  return { path: input.page.path, canonicalUrl: input.page.canonicalUrl, etag: input.page.etag };
}
