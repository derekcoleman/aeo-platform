import { getSiteRenderConfig, type SiteRenderConfig } from "./site-config";
import { publicHostFromHeaders } from "./context";
import type { PublishedPage } from "./published";
import { assertNoEdgeHostname, type PublicHostResolution } from "@/lib/tenancy";

export interface RouteContext {
  config: SiteRenderConfig;
  host: PublicHostResolution;
}

export async function routeContext(siteId: string): Promise<RouteContext | null> {
  const config = await getSiteRenderConfig(siteId);
  if (!config) return null;
  return { config, host: await publicHostFromHeaders(config.canonicalDomain) };
}

/**
 * Every render response varies on the forwarded host: the same internal URL
 * answers a verified public host (indexable, canonical on their domain) and a
 * direct or forged one (noindex). A cache that honours Vary must not hand one
 * to the other. Cloudflare's edge does not honour it, which is why Worker v2
 * caches on one host only (its CONFIG.cacheHost, the site's canonical domain
 * unless the customer routes it on another).
 */
export const RENDER_VARY = "X-Forwarded-Host";

/**
 * A response we would not let be indexed is never stored by a shared cache:
 * cached under the article's URL it could be served to the customer's real
 * host, noindex and all.
 */
export const NOINDEX_CACHE_CONTROL = "private, no-store";

/**
 * The validator and robots header for one representation of an article.
 * The stored etag hashes body and head at publish time, but taking a page
 * out of the index or pausing the site adds a robots meta without touching
 * either, so the robots state is part of the tag: a cache answering
 * If-None-Match from its own copy must not 304 a crawler that holds the
 * indexable copy (or, after a restore, the noindex one). X-Robots-Tag covers
 * the .md variant too, which has no <head> to carry a meta.
 */
export function articleHeaders(
  page: Pick<PublishedPage, "etag" | "status">,
  config: Pick<SiteRenderConfig, "indexingPaused">,
  variant: "html" | "md",
): Record<string, string> {
  const noindex = page.status === "noindex" || config.indexingPaused;
  // Publish stores its tag quoted and the seed does not; either way the header is one quoted string.
  const tag = page.etag.replace(/^W\//, "").replace(/"/g, "");
  return {
    etag: `"${tag}${noindex ? "-noindex" : ""}${variant === "md" ? "-md" : ""}"`,
    ...(noindex ? { "x-robots-tag": "noindex" } : {}),
  };
}

export interface RenderResponseOptions {
  /** The verified-public-host verdict middleware made (RouteContext.host.indexable). */
  indexable: boolean;
}

/**
 * Text responses on the public path go through here so the edge-hostname
 * invariant covers sitemaps, feeds and llms.txt too — not just HTML. A leaked
 * hostname in a sitemap is arguably worse than one in a page, because it tells
 * a crawler the canonical location directly.
 */
export function textResponse(
  body: string,
  contentType: string,
  extraHeaders: Record<string, string>,
  { indexable }: RenderResponseOptions,
): Response {
  if (process.env.NODE_ENV !== "production") {
    assertNoEdgeHostname(body, contentType);
  }
  return new Response(body, {
    headers: {
      "content-type": contentType,
      // Long stale windows on purpose: if we 5xx, a compliant CDN keeps serving
      // the last good copy rather than showing an error on someone's own domain.
      "cache-control":
        "public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800",
      ...extraHeaders,
      // Last, so no caller can make a noindex response cacheable.
      ...(indexable ? {} : { "cache-control": NOINDEX_CACHE_CONTROL }),
      vary: RENDER_VARY,
    },
  });
}
