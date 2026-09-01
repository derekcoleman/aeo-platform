import { resolvePublicHost } from "./resolve-site";
import type { SiteRoute } from "./types";
import { isEdgeHost, isWithinPrefix, normaliseHost, normaliseTrailingSlash, toInternalPath } from "./urls";

/**
 * The proxy contract, as a pure function.
 *
 * All of the reverse-proxy decision making lives here so it can be tested
 * without HTTP, a database, or a running Next server. `middleware.ts` is only
 * responsible for I/O: read headers, call `decideProxyAction`, build a response.
 */

/** Max proxy hops before we declare a loop. Their edge is 1, ours is 2. */
export const MAX_HOPS = 2;

export const HEADER = {
  hops: "x-aeo-hops",
  site: "x-aeo-site",
  passthrough: "x-aeo-passthrough",
  forwardedHost: "x-forwarded-host",
} as const;

export interface ProxyInput {
  /** The `Host` header — one of our per-site edge hostnames. */
  host: string | null;
  /** The customer's original host, set by their proxy. Untrusted. */
  forwardedHost: string | null;
  pathname: string;
  /** `X-AEO-Hops`, incremented by each proxy that understands it. */
  hops: string | null;
  /** Resolved from `host`; null when we do not recognise it. */
  site: SiteRoute | null;
}

export type ProxyAction =
  /**
   * We do not serve this. Answered 404 with `X-AEO-Passthrough`, which tells a
   * Mode A Worker to re-fetch the customer's real origin — so a path collision
   * degrades to "their page wins" rather than "their page is gone".
   */
  | { kind: "passthrough"; status: 404 }
  /** A misconfigured rewrite is bouncing the request back to us. */
  | { kind: "loop"; status: 508 }
  /** Trailing-slash normalisation. Location MUST be root-relative. */
  | { kind: "redirect"; status: 301; location: string }
  /** Serve it. */
  | {
      kind: "render";
      siteId: string;
      internalPath: string;
      canonicalDomain: string;
      indexable: boolean;
    };

export function decideProxyAction(input: ProxyInput): ProxyAction {
  // Loop guard first: a looping request must be cheap to reject, and must not
  // reach anything that touches the database.
  const hops = Number.parseInt(input.hops ?? "0", 10);
  if (Number.isFinite(hops) && hops > MAX_HOPS) {
    return { kind: "loop", status: 508 };
  }

  // Secondary loop guard. If the "original" host is one of ours, the customer
  // pointed their rewrite at the edge hostname instead of their own domain, or
  // orange-clouded a record that is also a Worker route. Either way, following
  // it would spin.
  if (input.forwardedHost && isEdgeHost(normaliseHost(input.forwardedHost))) {
    return { kind: "loop", status: 508 };
  }

  if (!input.site) {
    return { kind: "passthrough", status: 404 };
  }

  // Requests outside the site's subtree are not ours to answer. This is the
  // path-collision case, and passthrough is what makes it non-destructive.
  if (!isWithinPrefix(input.pathname, input.site.pathPrefix)) {
    return { kind: "passthrough", status: 404 };
  }

  const redirectTo = normaliseTrailingSlash(
    input.pathname,
    input.site.trailingSlash,
    input.site.pathPrefix,
  );
  if (redirectTo) {
    // Root-relative on purpose: an absolute Location would carry our edge
    // hostname into a customer-visible response.
    return { kind: "redirect", status: 301, location: redirectTo };
  }

  const publicHost = resolvePublicHost(input.site, input.forwardedHost);
  return {
    kind: "render",
    siteId: input.site.id,
    internalPath: toInternalPath(input.site.id, input.pathname),
    canonicalDomain: publicHost.canonicalDomain,
    indexable: publicHost.indexable,
  };
}

/**
 * Request headers that must never reach a handler on the public render path.
 *
 * Because the blog is served same-origin with the customer's own site, the
 * browser attaches THEIR session cookies to every article request. A Mode A
 * Worker strips these at their edge, but the other install modes cannot, so we
 * drop them here as well and keep them out of every log sink. We also never set
 * a cookie on their domain — not for analytics, not for anything.
 */
export const STRIPPED_REQUEST_HEADERS = ["cookie", "authorization", "proxy-authorization"] as const;
