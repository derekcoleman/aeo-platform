import type { PublicHostResolution, SiteRoute, SlashMode } from "./types";

/**
 * The single most important invariant in the render path:
 *
 *   NO RENDERED BYTE MAY CONTAIN OUR EDGE HOSTNAME.
 *
 * Pages are served from the customer's own domain. Any absolute URL pointing at
 * `*.blogedge.*` that escapes into HTML, a canonical tag, a redirect Location,
 * JSON-LD, a sitemap or an RSS feed either leaks our infrastructure to their
 * users or — worse — tells search and answer engines that the canonical home of
 * their content is a third-party host.
 *
 * The design makes this mostly structural rather than a thing to remember:
 * because the site's path prefix stays in the public URL and the tenant id goes
 * into an *internal* rewrite target, rendered hrefs are already identical to
 * public URLs. There is no link rewriting to get wrong. These helpers cover the
 * remaining cases (canonical, og:url, JSON-LD @id, sitemap, feed) and
 * `assertNoEdgeHostname` is the backstop.
 */

/** Suffix of the wildcard zone customer proxies target. */
export const EDGE_DOMAIN_SUFFIX = process.env.AEO_EDGE_DOMAIN ?? "blogedge.aeo.app";

export class EdgeHostnameLeakError extends Error {
  constructor(where: string, sample: string) {
    super(
      `Edge hostname leaked into ${where}. Rendered output must only ever ` +
        `reference the customer's own domain. Offending fragment: ${sample}`,
    );
    this.name = "EdgeHostnameLeakError";
  }
}

/**
 * Backstop against the invariant above. Runs on every rendered response in
 * development and on a sample in production.
 */
export function assertNoEdgeHostname(output: string, where = "rendered output"): void {
  const idx = output.indexOf(EDGE_DOMAIN_SUFFIX);
  if (idx === -1) return;
  throw new EdgeHostnameLeakError(
    where,
    output.slice(Math.max(0, idx - 60), idx + EDGE_DOMAIN_SUFFIX.length + 60),
  );
}

/** True when `host` is one of our per-site edge hostnames. */
export function isEdgeHost(host: string): boolean {
  return normaliseHost(host).endsWith(`.${EDGE_DOMAIN_SUFFIX}`);
}

/** Lowercase, strip port, strip a trailing dot (FQDN form). */
export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().split(":")[0]!.replace(/\.$/, "");
}

/**
 * Normalise a path prefix to the stored form: leading slash, no trailing slash.
 * `/` is not a legal prefix — a site must own a subtree, never the customer's
 * whole domain.
 */
export function normalisePathPrefix(prefix: string): string {
  const p = "/" + prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "/") throw new Error("path_prefix must be a subtree, not '/'");
  return p;
}

/** Does this path fall inside the site's subtree? */
export function isWithinPrefix(pathname: string, pathPrefix: string): boolean {
  return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

/**
 * Map a public path onto the internal render route.
 *
 * `/resources/hello` -> `/_sites/<siteId>/resources/hello`
 *
 * Putting the tenant id in the internal path means Next's Full Route Cache and
 * Data Cache are keyed on something tenant-scoped, so a misbehaving host-based
 * cache layer still cannot serve tenant A's page for tenant B.
 */
export function toInternalPath(siteId: string, publicPath: string): string {
  return `/_sites/${siteId}${publicPath}`;
}

/** Inverse of `toInternalPath`. */
export function toPublicPath(siteId: string, internalPath: string): string {
  const marker = `/_sites/${siteId}`;
  return internalPath.startsWith(marker) ? internalPath.slice(marker.length) || "/" : internalPath;
}

/**
 * Apply the site's trailing-slash policy. Returns null when already correct.
 *
 * The caller must emit this as a ROOT-RELATIVE Location. An absolute redirect
 * would carry our edge hostname, which is exactly what `assertNoEdgeHostname`
 * exists to prevent — and why `skipTrailingSlashRedirect` is set in
 * next.config.ts so Next never does this for us.
 */
export function normaliseTrailingSlash(
  pathname: string,
  mode: SlashMode,
  pathPrefix: string,
): string | null {
  // The prefix root itself is exempt: both `/resources` and `/resources/` are
  // the index, and bouncing between them is a redirect loop waiting to happen.
  if (pathname === pathPrefix || pathname === `${pathPrefix}/`) return null;

  if (mode === "never" && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "") || "/";
  }
  if (mode === "always" && !pathname.endsWith("/")) {
    return `${pathname}/`;
  }
  return null;
}

/**
 * Build an absolute public URL for canonical tags, og:url, JSON-LD @id, sitemap
 * entries and feeds.
 *
 * Takes the *resolved* public host rather than the site, so an unverified
 * forwarded host cannot produce an absolute URL that asserts a canonical we
 * have not confirmed.
 */
export function absoluteUrl(resolution: PublicHostResolution, path: string): string {
  const host = normaliseHost(resolution.canonicalDomain);
  if (isEdgeHost(host)) {
    throw new EdgeHostnameLeakError("absoluteUrl()", host);
  }
  return `https://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Public URL of a content item, given its slug. */
export function contentUrl(
  resolution: PublicHostResolution,
  site: Pick<SiteRoute, "pathPrefix" | "trailingSlash">,
  slug: string,
): string {
  const base = `${site.pathPrefix}/${slug}`;
  return absoluteUrl(resolution, site.trailingSlash === "always" ? `${base}/` : base);
}
