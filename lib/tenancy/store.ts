import type { ProxyMode, SiteRoute, SlashMode } from "./types";
import { normaliseHost } from "./urls";
import { SiteResolver, type SiteStore } from "./resolve-site";

/**
 * Site lookup over PostgREST.
 *
 * Middleware runs on the edge runtime, where the `postgres` driver is not
 * available, so resolution goes over HTTP rather than a socket. This reads a
 * single row by unique key and is fronted by SiteResolver's cache.
 */
export class HttpSiteStore implements SiteStore {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async byEdgeHostname(host: string): Promise<SiteRoute | null> {
    const url = new URL(`${this.baseUrl}/rest/v1/sites`);
    url.searchParams.set("edge_hostname", `eq.${normaliseHost(host)}`);
    url.searchParams.set(
      "select",
      [
        "id",
        "org_id",
        "canonical_domain",
        "path_prefix",
        "edge_hostname",
        "proxy_mode",
        "trailing_slash",
        "locale",
        "status",
        "site_domains(hostname)",
      ].join(","),
    );
    url.searchParams.set("limit", "1");

    const res = await this.fetchImpl(url, {
      headers: {
        apikey: this.apiKey,
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
      // Site config changes rarely; SiteResolver holds the short-lived cache.
      cache: "no-store",
    });
    if (!res.ok) return null;

    const rows = (await res.json()) as SiteRow[];
    const row = rows[0];
    return row ? toSiteRoute(row) : null;
  }
}

interface SiteRow {
  id: string;
  org_id: string;
  canonical_domain: string;
  path_prefix: string;
  edge_hostname: string;
  proxy_mode: ProxyMode;
  trailing_slash: SlashMode;
  locale: string;
  status: SiteRoute["status"];
  site_domains?: { hostname: string }[];
}

export function toSiteRoute(row: SiteRow): SiteRoute {
  // The canonical domain is always an allowed forwarded host, even if nobody
  // has added an explicit site_domains row for it yet.
  const hosts = new Set<string>([normaliseHost(row.canonical_domain)]);
  for (const d of row.site_domains ?? []) hosts.add(normaliseHost(d.hostname));

  return {
    id: row.id,
    orgId: row.org_id,
    canonicalDomain: normaliseHost(row.canonical_domain),
    pathPrefix: row.path_prefix,
    edgeHostname: normaliseHost(row.edge_hostname),
    proxyMode: row.proxy_mode,
    trailingSlash: row.trailing_slash,
    locale: row.locale,
    status: row.status,
    allowedHosts: [...hosts],
  };
}

let shared: SiteResolver | null = null;

/** Process-wide resolver, so the cache survives across requests on an instance. */
export function siteResolver(): SiteResolver {
  if (shared) return shared;
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const apiKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  shared = new SiteResolver(new HttpSiteStore(baseUrl, apiKey));
  return shared;
}
