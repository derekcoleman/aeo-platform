/** A publishable surface: one (canonical_domain, path_prefix) pair. */
export type ProxyMode =
  | "cloudflare_worker"
  | "vercel_rewrite"
  | "nginx"
  | "netlify"
  | "subdomain";

export type SlashMode = "never" | "always";

export interface SiteRoute {
  id: string;
  orgId: string;
  /** The customer's own domain, e.g. `acme.com`. */
  canonicalDomain: string;
  /** Kept in the PUBLIC url, e.g. `/resources`. Never has a trailing slash. */
  pathPrefix: string;
  /** Our non-guessable per-site host. MUST NOT appear in rendered output. */
  edgeHostname: string;
  proxyMode: ProxyMode;
  trailingSlash: SlashMode;
  locale: string;
  status: "provisioning" | "verifying" | "active" | "paused" | "disabled";
  /** Hosts we will honour in x-forwarded-host, including canonicalDomain. */
  allowedHosts: string[];
}

/**
 * The outcome of validating the forwarded host.
 *
 * `indexable: false` is the safe default whenever we cannot prove which public
 * host the request arrived on. Serving an indexable page under an unverified
 * host would create a duplicate of the customer's content on a third-party
 * domain, which is the most damaging thing this architecture can do to them.
 */
export interface PublicHostResolution {
  canonicalDomain: string;
  indexable: boolean;
  reason?: "no-forwarded-host" | "unknown-forwarded-host" | "site-not-active";
}
