import { randomBytes } from "node:crypto";
import { sitemapLocs } from "@/lib/audit/html";
import { safeFetch, type FetchResult } from "@/lib/fetch";
import { EDGE_DOMAIN_SUFFIX, HEADER, type ProxyMode, type SlashMode } from "@/lib/tenancy";
import { CAPABILITIES } from "./install";

/**
 * The proxy health check, run through the CUSTOMER's edge (never our origin
 * directly): a customer edge that adds CSP, drops a header or strips
 * Cache-Control after fetching from us is invisible to an origin fetch.
 *
 * One call, one verdict, a list of named checks. A `fail` means pages are
 * broken or unsafe for the customer; a `warn` means something is degraded
 * (partial crawl coverage, a missing sitemap line) and worth a nudge, not a
 * page. Used by the 5-minute monitor, by onboarding verification, and by the
 * preflight.
 */

export interface HealthCheckItem {
  key: string;
  ok: boolean;
  severity: "fail" | "warn";
  detail: Record<string, unknown>;
}

export interface HealthSite {
  id: string;
  canonicalDomain: string;
  pathPrefix: string;
  edgeHostname: string;
  proxyMode: ProxyMode;
  trailingSlash: SlashMode;
}

export interface HealthOptions {
  fetchImpl?: typeof fetch;
  allowPrivate?: boolean;
  timeoutMs?: number;
  /** A published article path (public, e.g. /resources/sso-vs-scim) to assert on; null skips the article checks. */
  articlePath?: string | null;
  /** Whether pages should currently be indexable (site active). Verification of a not-yet-active site passes false. */
  expectIndexable?: boolean;
  nonce?: () => string;
}

export interface HealthResult {
  ok: boolean;
  ttfbMs: number | null;
  checks: HealthCheckItem[];
  failed: string[];
  warnings: string[];
}

interface HealthPayload {
  ok?: boolean;
  siteId?: string;
  nonce?: string | null;
  received?: { forwardedHost?: string | null; hops?: string | null; indexable?: boolean; sawCookie?: boolean; sawAuthorization?: boolean };
}

export function publicOrigin(site: Pick<HealthSite, "canonicalDomain">): string {
  return `https://${site.canonicalDomain}`;
}

async function get(url: string, opts: HealthOptions, extra: { headers?: Record<string, string>; maxRedirects?: number } = {}): Promise<{ res: FetchResult | null; error: string | null }> {
  try {
    const res = await safeFetch(url, { fetchImpl: opts.fetchImpl, allowPrivate: opts.allowPrivate, timeoutMs: opts.timeoutMs ?? 12_000, maxRetries: 0, maxRedirects: extra.maxRedirects ?? 3, maxBytes: 1024 * 1024, headers: extra.headers, userAgent: "aeo-platform-health/1.0 (+https://aeo.app/health)" });
    return { res, error: null };
  } catch (e) {
    return { res: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const TLS_ERROR_RE = /certificate|CERT_|ERR_TLS|SSL|TLS|self[- ]signed|unable to verify/i;

/** Does a CSP allow the inline `<style>` block every article carries? Absent CSP → yes. */
export function cspAllowsInlineStyle(csp: string | null): { allows: boolean; directive: string | null } {
  if (!csp) return { allows: true, directive: null };
  const directives = new Map(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...vals] = d.split(/\s+/);
    return [name!.toLowerCase(), vals.map((v) => v.replace(/^'|'$/g, "").toLowerCase())] as const;
  }));
  const style = directives.get("style-src") ?? directives.get("style-src-elem") ?? directives.get("default-src");
  if (!style) return { allows: true, directive: null };
  const allows = style.includes("unsafe-inline") || style.some((v) => v.startsWith("nonce-") || v.startsWith("sha256-") || v.startsWith("sha384-") || v.startsWith("sha512-"));
  const name = directives.has("style-src") ? "style-src" : directives.has("style-src-elem") ? "style-src-elem" : "default-src";
  return { allows, directive: `${name} ${style.join(" ")}` };
}

export function canonicalHrefOf(html: string): string | null {
  const m = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html) ?? /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(html);
  return m?.[1] ?? null;
}

export function robotsMetaOf(html: string): string | null {
  const m = /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']robots["']/i.exec(html);
  return m?.[1] ?? null;
}

export async function runHealthCheck(site: HealthSite, opts: HealthOptions = {}): Promise<HealthResult> {
  const checks: HealthCheckItem[] = [];
  const push = (key: string, ok: boolean, severity: HealthCheckItem["severity"], detail: Record<string, unknown> = {}) => checks.push({ key, ok, severity, detail });
  const origin = publicOrigin(site);
  const caps = CAPABILITIES[site.proxyMode];
  const nonce = opts.nonce?.() ?? randomBytes(8).toString("hex");
  let ttfbMs: number | null = null;

  // ── the health endpoint, through their edge, carrying a cookie and a token ──
  const healthUrl = `${origin}${site.pathPrefix}/aeo-health?nonce=${nonce}`;
  const health = await get(healthUrl, opts, { headers: { cookie: "aeo_probe=1", authorization: "Bearer aeo-probe" } });
  let payload: HealthPayload | null = null;
  if (!health.res) {
    const tls = TLS_ERROR_RE.test(health.error ?? "");
    push(tls ? "tls" : "health_endpoint", false, "fail", { url: healthUrl, error: health.error });
  } else {
    ttfbMs = health.res.durationMs;
    try {
      payload = JSON.parse(health.res.body) as HealthPayload;
    } catch {
      payload = null;
    }
    const siteHeader = health.res.headers.get(HEADER.site);
    const ours = health.res.status === 200 && payload?.ok === true && payload.siteId === site.id;
    push("health_endpoint", ours, "fail", { url: healthUrl, status: health.res.status, siteId: payload?.siteId ?? null, siteHeader, ttfbMs, redirects: health.res.redirects });
    if (ours) {
      push("site_header", siteHeader === site.id, "fail", { expected: site.id, got: siteHeader });
      push("nonce_echo", payload?.nonce === nonce, "fail", { expected: nonce, got: payload?.nonce ?? null, hint: "a stale or cached answer — the health path must not be cached by their edge" });
      const r = payload?.received ?? {};
      const stripped = r.sawCookie === false && r.sawAuthorization === false;
      // Modes that cannot strip at their edge are disclosed at install; here it is a warning, not an outage.
      push("cookie_stripped", stripped, caps.stripsCookies ? "fail" : "warn", { sawCookie: r.sawCookie ?? null, sawAuthorization: r.sawAuthorization ?? null, mode: site.proxyMode });
      push("forwarded_host", !!r.forwardedHost, "fail", { forwardedHost: r.forwardedHost ?? null, hint: "without x-forwarded-host every page we serve is noindex" });
      if (opts.expectIndexable) push("indexable", r.indexable === true, "fail", { indexable: r.indexable ?? null, forwardedHost: r.forwardedHost ?? null });
      push("hops", r.hops == null || Number(r.hops) <= 1, "warn", { hops: r.hops ?? null });
      const csp = cspAllowsInlineStyle(health.res.headers.get("content-security-policy"));
      push("csp_inline_style", csp.allows, "fail", { directive: csp.directive, hint: "article pages inline their theme CSS; allow 'unsafe-inline' for style-src on the content prefix" });
      push("crawl_coverage", caps.crawlCoverage === "full", "warn", { mode: site.proxyMode, coverage: caps.crawlCoverage });
    }
  }

  // ── a real article ─────────────────────────────────────────────────────────
  if (opts.articlePath) {
    const url = `${origin}${opts.articlePath}`;
    const art = await get(url, opts);
    if (!art.res) {
      push("article", false, "fail", { url, error: art.error });
    } else {
      push("article", art.res.status === 200, "fail", { url, status: art.res.status, redirects: art.res.redirects, durationMs: art.res.durationMs });
      if (art.res.status === 200) {
        const body = art.res.body;
        const leak = body.includes(site.edgeHostname) || body.includes(EDGE_DOMAIN_SUFFIX);
        push("no_edge_hostname", !leak, "fail", { edgeHostname: site.edgeHostname });
        const canonical = canonicalHrefOf(body);
        push("canonical", canonical === url, "fail", { expected: url, got: canonical });
        const robots = robotsMetaOf(body);
        const noindex = /noindex/i.test(robots ?? "");
        if (opts.expectIndexable) push("not_noindex", !noindex, "fail", { robots });
        const setCookie = art.res.headers.get("set-cookie");
        push("no_set_cookie", !setCookie, "fail", { setCookie: setCookie ? "present" : null });
        const cc = art.res.headers.get("cache-control") ?? "";
        push("cache_control_kept", /s-maxage|max-age/i.test(cc), "warn", { cacheControl: cc || null, hint: "their edge stripped Cache-Control; every hit reaches us" });
      }
      // Trailing-slash normalisation must be one root-relative hop, never a chain.
      const variant = site.trailingSlash === "never" ? `${url}/` : url.replace(/\/$/, "");
      const red = await get(variant, opts, { maxRedirects: 5 });
      if (red.res) {
        push("redirect_depth", red.res.redirects.length <= 1 && red.res.status === 200, "fail", { url: variant, redirects: red.res.redirects, status: red.res.status });
      } else {
        push("redirect_depth", false, "fail", { url: variant, error: red.error });
      }
    }
  }

  // ── the one line we ask for in their robots.txt, and the sitemap it names ──
  const sitemapUrl = `${origin}${site.pathPrefix}/sitemap.xml`;
  const robots = await get(`${origin}/robots.txt`, opts);
  const hasLine = !!robots.res && robots.res.status === 200 && new RegExp(`^\\s*sitemap:\\s*${escapeRe(sitemapUrl)}\\s*$`, "im").test(robots.res.body);
  push("sitemap_line", hasLine, "warn", { expected: `Sitemap: ${sitemapUrl}`, robotsStatus: robots.res?.status ?? null, error: robots.error });
  const sm = await get(sitemapUrl, opts);
  if (sm.res && sm.res.status === 200) {
    const parsed = sitemapLocs(sm.res.body);
    push("sitemap", /<urlset|<sitemapindex/i.test(sm.res.body), "fail", { url: sitemapUrl, urls: parsed.urls.length });
  } else {
    push("sitemap", false, "fail", { url: sitemapUrl, status: sm.res?.status ?? null, error: sm.error });
  }

  const failed = checks.filter((c) => !c.ok && c.severity === "fail").map((c) => c.key);
  const warnings = checks.filter((c) => !c.ok && c.severity === "warn").map((c) => c.key);
  return { ok: failed.length === 0, ttfbMs, checks, failed, warnings };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
