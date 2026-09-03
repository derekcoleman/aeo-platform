import { resolvePublicHost } from "./resolve-site";
import type { SiteRoute } from "./types";
import {
  isEdgeHost,
  isReservedPath,
  isRootPath,
  isWithinPrefix,
  normaliseHost,
  normaliseTrailingSlash,
  toInternalPath,
} from "./urls";

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

/**
 * Internal request headers middleware attaches for the render handler.
 *
 * The renderer connects as a least-privilege role that can read exactly one
 * table, so it cannot look site config up for itself. Passing the resolved
 * values forward keeps that restriction intact and avoids a second round trip
 * on every page view. These are request-only and never echoed to a client.
 */
export const INTERNAL_HEADER = {
  siteId: "x-aeo-internal-site-id",
  canonicalDomain: "x-aeo-internal-canonical-domain",
  pathPrefix: "x-aeo-internal-path-prefix",
  locale: "x-aeo-internal-locale",
  indexable: "x-aeo-internal-indexable",
  trailingSlash: "x-aeo-internal-trailing-slash",
  /**
   * Root-relative Location for a trailing-slash normalisation.
   *
   * The redirect is emitted by the route handler rather than by middleware,
   * because Next's middleware runtime parses the `Location` header as an
   * absolute URL and throws on a relative one — and relative is exactly what we
   * need, since an absolute Location would carry our edge hostname into a
   * customer-visible response.
   */
  redirect: "x-aeo-internal-redirect",
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
  /**
   * Serve it.
   *
   * `redirectTo`, when present, means the path needs trailing-slash
   * normalisation and the handler should answer 301 with that ROOT-RELATIVE
   * Location. The redirect is deliberately not emitted by middleware: Next's
   * middleware runtime parses `Location` as an absolute URL and throws on a
   * relative one — and relative is the whole point, because an absolute
   * Location would carry our edge hostname into a customer-visible response.
   */
  | {
      kind: "render";
      siteId: string;
      internalPath: string;
      canonicalDomain: string;
      indexable: boolean;
      site: SiteRoute;
      redirectTo?: string;
    };

export function decideProxyAction(input: ProxyInput): ProxyAction {
  // Loop guard first: a looping request must be cheap to reject, and must not
  // reach anything that touches the database.
  const hops = Number.parseInt(input.hops ?? "0", 10);
  if (Number.isFinite(hops) && hops > MAX_HOPS) {
    return { kind: "loop", status: 508 };
  }

  // Secondary loop guard: the "original" host is one of OURS but not the host
  // this request arrived on. That means a customer pointed their rewrite at an
  // edge hostname instead of their own domain, or orange-clouded a record that
  // is also a Worker route — following it would spin.
  //
  // Note the inequality. Servers (Next's included) populate x-forwarded-host
  // from Host when nothing upstream set it, so forwardedHost === host is the
  // ordinary shape of a DIRECT request to our edge — a health check or a
  // scanner, not a loop. Those are handled below and simply render noindex.
  const forwarded = input.forwardedHost ? normaliseHost(input.forwardedHost) : null;
  const arrivedOn = input.host ? normaliseHost(input.host) : null;
  if (forwarded && isEdgeHost(forwarded) && forwarded !== arrivedOn) {
    return { kind: "loop", status: 508 };
  }

  // Our internal rewrite target is a real route, so a request that arrives at
  // it from the outside must never be served directly — that would bypass host
  // validation and let anyone render any site by guessing an id.
  if (isReservedPath(input.pathname)) {
    return { kind: "passthrough", status: 404 };
  }

  if (!input.site) {
    return { kind: "passthrough", status: 404 };
  }

  // Requests outside the site's subtree are not ours to answer, except for the
  // handful of root paths customers rewrite to us on purpose. This is the
  // path-collision case, and passthrough is what makes it non-destructive.
  if (!isWithinPrefix(input.pathname, input.site.pathPrefix) && !isRootPath(input.pathname)) {
    return { kind: "passthrough", status: 404 };
  }

  const redirectTo = normaliseTrailingSlash(
    input.pathname,
    input.site.trailingSlash,
    input.site.pathPrefix,
  );

  // A forwarded host equal to our own edge hostname carries no information
  // about the public host, so treat it as absent: render, but never indexable.
  const publicHost = resolvePublicHost(
    input.site,
    forwarded && isEdgeHost(forwarded) ? null : input.forwardedHost,
  );
  return {
    kind: "render",
    siteId: input.site.id,
    // Rewrite to the normalised path so the handler resolves the right page
    // even on the request that will be redirected.
    internalPath: toInternalPath(input.site.id, redirectTo ?? input.pathname),
    ...(redirectTo ? { redirectTo } : {}),
    canonicalDomain: publicHost.canonicalDomain,
    indexable: publicHost.indexable,
    site: input.site,
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
