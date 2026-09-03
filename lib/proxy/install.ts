import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProxyMode, SiteRoute } from "@/lib/tenancy";

/**
 * Generates the proxy config we hand a customer, per install mode.
 *
 * The modes are NOT equivalent, and the UI must say so rather than presenting
 * four equal options. Only the Cloudflare Worker can strip cookies at their
 * edge, verify the response belongs to their site, fall back to a mirror, pass
 * through on a path collision, and report crawler hits that our origin never
 * sees. Everything else is a degraded install, and a customer who picks one
 * should know what they gave up.
 */

export interface InstallCapabilities {
  /** Can drop the customer's session cookies before they reach us. */
  stripsCookies: boolean;
  /** Can add request headers (HMAC signature, explicit hop counter). */
  customRequestHeaders: boolean;
  /** Sends x-forwarded-host, without which every page we serve is noindex. */
  forwardsHost: boolean;
  /** Re-fetches their origin when we 404, so their own page wins a collision. */
  passthroughOnCollision: boolean;
  /** Serves a mirror when we are down. */
  fallbackOrigin: boolean;
  /** Crawl telemetry coverage. Partial means origin misses only. */
  crawlCoverage: "full" | "partial";
}

export const CAPABILITIES: Record<ProxyMode, InstallCapabilities> = {
  cloudflare_worker: {
    stripsCookies: true,
    customRequestHeaders: true,
    forwardsHost: true,
    passthroughOnCollision: true,
    fallbackOrigin: true,
    crawlCoverage: "full",
  },
  // Vercel rewrites proxy server-side and forward x-forwarded-host, but cannot
  // add request headers and cannot strip cookies. Disclose both.
  vercel_rewrite: {
    stripsCookies: false,
    customRequestHeaders: false,
    forwardsHost: true,
    passthroughOnCollision: false,
    fallbackOrigin: false,
    crawlCoverage: "partial",
  },
  nginx: {
    stripsCookies: true,
    customRequestHeaders: true,
    forwardsHost: true,
    passthroughOnCollision: false,
    fallbackOrigin: false,
    crawlCoverage: "partial",
  },
  // Netlify does not forward custom headers; treat as Vercel-class.
  netlify: {
    stripsCookies: false,
    customRequestHeaders: false,
    forwardsHost: true,
    passthroughOnCollision: false,
    fallbackOrigin: false,
    crawlCoverage: "partial",
  },
  // Last resort. A subdomain is weaker for AEO than a subfolder: link equity
  // and domain-entity association do not carry across. Track proxy_mode as a
  // measurement cohort so these tenants' results are read in that light.
  subdomain: {
    stripsCookies: true,
    customRequestHeaders: false,
    forwardsHost: true,
    passthroughOnCollision: false,
    fallbackOrigin: false,
    crawlCoverage: "partial",
  },
};

export interface InstallContext {
  site: Pick<SiteRoute, "id" | "canonicalDomain" | "pathPrefix" | "edgeHostname" | "proxyMode"> & {
    name: string;
  };
  hmacSecret?: string;
  mirrorOrigin?: string;
  crawlEndpoint?: string;
}

export interface InstallInstructions {
  mode: ProxyMode;
  capabilities: InstallCapabilities;
  /** The file the customer deploys, and where it goes. */
  filename: string;
  config: string;
  /** Route pattern, where the mode needs one configured separately. */
  routePattern?: string;
  /** Things the customer must know before choosing this mode. */
  warnings: string[];
  /** Additional rewrites we ask for beyond the content prefix. */
  extraRewrites: { source: string; reason: string }[];
}

const TEMPLATE_PATH = join(process.cwd(), "edge", "customer-worker.template.js");

export function buildInstall(ctx: InstallContext): InstallInstructions {
  const caps = CAPABILITIES[ctx.site.proxyMode];
  const warnings = warningsFor(ctx.site.proxyMode, caps);

  return {
    mode: ctx.site.proxyMode,
    capabilities: caps,
    warnings,
    extraRewrites: extraRewrites(),
    ...renderConfig(ctx),
  };
}

function warningsFor(mode: ProxyMode, caps: InstallCapabilities): string[] {
  const out: string[] = [];
  if (!caps.stripsCookies) {
    out.push(
      "This mode cannot strip cookies at your edge, so your session cookies will " +
        "reach our origin on every article request. We drop them before any handler " +
        "or log sink sees them and never set a cookie on your domain, but if your " +
        "session cookie is not Path-scoped away from this prefix, the Cloudflare " +
        "Worker mode avoids the exposure entirely.",
    );
  }
  if (!caps.passthroughOnCollision) {
    out.push(
      "If you later publish your own page under this prefix, we cannot fall back to " +
        "your origin for it — the path must stay ours.",
    );
  }
  if (!caps.fallbackOrigin) {
    out.push(
      "No static mirror fallback. If we are unavailable, this prefix serves stale " +
        "cache or an error. The rest of your site is unaffected either way.",
    );
  }
  if (caps.crawlCoverage === "partial") {
    out.push(
      "Crawl telemetry will be partial: we only see requests that miss your cache, " +
        "so AI crawler counts are a floor, not a total. Reported as 'partial' in the " +
        "dashboard rather than presented as complete.",
    );
  }
  if (mode === "subdomain") {
    out.push(
      "A subdomain is measurably weaker for AI search than a subfolder — link equity " +
        "and domain-entity association do not carry across. Use this only if your " +
        "stack genuinely cannot rewrite.",
    );
  }
  return out;
}

/**
 * We ask for these beyond the content prefix. Root-level llms.txt is meaningfully
 * better than one buried under the prefix, and these paths are otherwise unused.
 *
 * We deliberately do NOT ask to proxy their root robots.txt: the blast radius of
 * getting that wrong is their entire site. Onboarding asks for one `Sitemap:`
 * line instead, and the health check verifies it.
 */
function extraRewrites(): { source: string; reason: string }[] {
  return [
    { source: "/llms.txt", reason: "Root-level index for answer engines and agent fetchers." },
    { source: "/llms-full.txt", reason: "Full-text corpus. We merge with any existing file rather than replacing it." },
    { source: "/.well-known/llms.txt", reason: "Discovery mirror." },
  ];
}

function renderConfig(ctx: InstallContext): Pick<InstallInstructions, "filename" | "config" | "routePattern"> {
  const { site } = ctx;
  switch (site.proxyMode) {
    case "cloudflare_worker": {
      const template = readFileSync(TEMPLATE_PATH, "utf8");
      return {
        filename: "aeo-proxy.worker.js",
        routePattern: `${site.canonicalDomain}${site.pathPrefix}/*`,
        config: template
          .replaceAll("{{SITE_NAME}}", site.name)
          .replaceAll("{{SITE_ID}}", site.id)
          .replaceAll("{{CANONICAL_DOMAIN}}", site.canonicalDomain)
          .replaceAll("{{PATH_PREFIX}}", site.pathPrefix)
          .replaceAll("{{EDGE_HOSTNAME}}", site.edgeHostname)
          .replaceAll("{{MIRROR_ORIGIN}}", ctx.mirrorOrigin ?? "")
          .replaceAll("{{CRAWL_ENDPOINT}}", ctx.crawlEndpoint ?? "")
          .replaceAll("{{HMAC_SECRET}}", ctx.hmacSecret ?? ""),
      };
    }

    case "vercel_rewrite":
      return {
        filename: "vercel.json",
        config: JSON.stringify(
          {
            rewrites: [
              {
                source: `${site.pathPrefix}/:path*`,
                destination: `https://${site.edgeHostname}${site.pathPrefix}/:path*`,
              },
              ...extraRewrites().map((r) => ({
                source: r.source,
                destination: `https://${site.edgeHostname}${r.source}`,
              })),
            ],
          },
          null,
          2,
        ),
      };

    case "netlify":
      return {
        filename: "_redirects",
        config: [
          `${site.pathPrefix}/* https://${site.edgeHostname}${site.pathPrefix}/:splat 200`,
          ...extraRewrites().map((r) => `${r.source} https://${site.edgeHostname}${r.source} 200`),
          "",
        ].join("\n"),
      };

    case "nginx":
      return {
        filename: "aeo-proxy.conf",
        config: nginxConfig(site.pathPrefix, site.edgeHostname),
      };

    case "subdomain":
      return {
        filename: "dns.txt",
        config: [
          `# Point a subdomain at us with a CNAME, then tell us the hostname.`,
          `# Certificates are issued automatically once the record resolves.`,
          ``,
          `resources.${site.canonicalDomain}.  CNAME  cname.aeo.app.`,
          ``,
        ].join("\n"),
      };
  }
}

function nginxConfig(pathPrefix: string, edgeHostname: string): string {
  return `# AEO content proxy. Include inside the server block for your site.
location ${pathPrefix}/ {
    proxy_pass         https://${edgeHostname};
    proxy_ssl_server_name on;
    proxy_set_header   Host              ${edgeHostname};
    proxy_set_header   X-Forwarded-Host  $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-AEO-Hops        1;

    # This content is served same-origin with your site, so browsers attach your
    # session cookies to every request. We neither want nor accept them.
    proxy_set_header   Cookie            "";
    proxy_set_header   Authorization     "";

    # Keep serving the last good copy if we are slow or unavailable. Only this
    # prefix is affected either way.
    proxy_connect_timeout 3s;
    proxy_read_timeout    10s;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
}
`;
}
