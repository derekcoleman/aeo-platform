import type { PublicHostResolution, SiteRoute } from "./types";
import { normaliseHost } from "./urls";

/**
 * Tenant resolution for the public render path.
 *
 * Tenancy comes from the `Host` header, for three reasons:
 *
 *  1. `Host` is the only channel EVERY proxy technology can set. Vercel's
 *     `rewrites` cannot add request headers, so a custom `X-Tenant-Id` would
 *     silently fail for a whole install mode.
 *  2. CDN cache keys include Host by default, so cross-tenant cache poisoning
 *     requires an active bug rather than being the default failure mode.
 *  3. It is reproducible: `curl -H 'Host: acme-8fj2.blogedge.aeo.app' ...`
 *     hits exactly what production hits.
 *
 * Each site's edge hostname is non-guessable, but note that it is not a
 * *secret* — the only thing it protects is which tenant's already-public
 * content is served. Real isolation comes from the tenant-in-path rewrite and
 * the least-privilege renderer role, not from the hostname being unguessable.
 */

export interface SiteStore {
  byEdgeHostname(host: string): Promise<SiteRoute | null>;
}

interface CacheEntry {
  value: SiteRoute | null;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Small in-process cache in front of the store. Serverless instances are
 * short-lived so the hit rate is modest, but it collapses the repeated lookups
 * a single request burst produces. Negative results are cached too, and for a
 * shorter time, so an unknown-host flood cannot hammer the database while a
 * genuinely new site still goes live promptly.
 */
export class SiteResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private store: SiteStore,
    private ttlMs: number = DEFAULT_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  async resolve(hostHeader: string | null | undefined): Promise<SiteRoute | null> {
    if (!hostHeader) return null;
    const host = normaliseHost(hostHeader);
    if (!host) return null;

    const hit = this.cache.get(host);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = await this.store.byEdgeHostname(host);
    this.cache.set(host, {
      value,
      expiresAt: this.now() + (value ? this.ttlMs : Math.min(this.ttlMs, 10_000)),
    });
    return value;
  }

  invalidate(host: string): void {
    this.cache.delete(normaliseHost(host));
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Decide which public host this request arrived on, and whether we are willing
 * to let the response be indexed under it.
 *
 * The customer's proxy tells us the original host via `x-forwarded-host`. That
 * header is attacker-controllable in principle, so it is validated against the
 * site's registered domains rather than trusted. Anything we cannot verify
 * falls back to the site's canonical domain and is marked NOT indexable.
 *
 * Getting this wrong in the permissive direction publishes a duplicate of the
 * customer's content under a host they do not control, so the failure mode is
 * deliberately "not indexed" rather than "404" or "trust it".
 */
export function resolvePublicHost(
  site: SiteRoute,
  forwardedHost: string | null | undefined,
): PublicHostResolution {
  if (site.status !== "active") {
    return {
      canonicalDomain: site.canonicalDomain,
      indexable: false,
      reason: "site-not-active",
    };
  }

  if (!forwardedHost) {
    // Direct hit on the edge hostname — us, a health check, or a scanner.
    // Never a real reader, so never indexable.
    return {
      canonicalDomain: site.canonicalDomain,
      indexable: false,
      reason: "no-forwarded-host",
    };
  }

  const host = normaliseHost(forwardedHost);
  const allowed = site.allowedHosts.map(normaliseHost);
  if (!allowed.includes(host)) {
    return {
      canonicalDomain: site.canonicalDomain,
      indexable: false,
      reason: "unknown-forwarded-host",
    };
  }

  return { canonicalDomain: host, indexable: true };
}
