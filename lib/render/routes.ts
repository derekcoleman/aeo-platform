import { getSiteRenderConfig, type SiteRenderConfig } from "./site-config";
import { publicHostFromHeaders } from "./context";
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
 * Text responses on the public path go through here so the edge-hostname
 * invariant covers sitemaps, feeds and llms.txt too — not just HTML. A leaked
 * hostname in a sitemap is arguably worse than one in a page, because it tells
 * a crawler the canonical location directly.
 */
export function textResponse(
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
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
    },
  });
}
