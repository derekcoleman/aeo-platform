import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { classifyUserAgent } from "@/lib/analytics/bots";
import { hmacHex, verifyRequestSignature } from "@/lib/tenancy/signature";
import { refreshSession } from "@/lib/auth/supabase";
import {
  HEADER,
  INTERNAL_HEADER,
  SiteLookupError,
  STRIPPED_REQUEST_HEADERS,
  decideProxyAction,
  isEdgeHost,
  siteResolver,
} from "@/lib/tenancy";

/**
 * The public render path's front door.
 *
 * All decision making lives in `decideProxyAction` (pure, unit tested). This
 * file is deliberately only I/O: read headers, ask the policy, build a
 * response.
 *
 * Request flow, for a customer who has rewritten acme.com/resources/* to us:
 *
 *   browser -> acme.com (their edge, adds Host + X-Forwarded-Host)
 *           -> acme-8fj2.blogedge.aeo.app (our edge)
 *           -> here: Host -> site, then rewrite to /_sites/<siteId>/resources/...
 */
export const config = {
  // Everything except Next internals, API routes and the app's own root
  // files. Edge hosts take the render path below; every other host is our own
  // app, where the only job is refreshing the auth session cookie. Do NOT
  // exclude by file extension here: proxied sitemap.xml / llms.txt /
  // feed.xml / robots.txt must reach the site resolver or they 404.
  matcher: ["/((?!_next/|api/|favicon.ico|robots.txt$).*)"],
};

const PROTECTED = ["/app", "/ops", "/settings"];

export async function middleware(req: NextRequest, event: NextFetchEvent) {
  const host = req.headers.get("host");

  // Only requests arriving on a per-site edge hostname are public render
  // traffic. Anything else (our own domains, local dev) passes straight
  // through to the app without touching the site store — so the app keeps
  // serving even when the store is unreachable or not yet configured.
  if (!host || !isEdgeHost(host)) {
    // Our own domain: refresh the Supabase session (rotated cookies land on
    // this response) and gate the authenticated surfaces. This branch never
    // runs for a customer's domain, so we never set a cookie there.
    const res = NextResponse.next();
    const { pathname } = req.nextUrl;
    const protectedPath = PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    try {
      const { userId } = await refreshSession(req, res);
      if (protectedPath && !userId) {
        const login = req.nextUrl.clone();
        login.pathname = "/login";
        login.search = `?next=${encodeURIComponent(pathname)}`;
        return NextResponse.redirect(login);
      }
    } catch (err) {
      // Auth not configured yet: pages render their own "not configured" state.
      console.warn("[aeo] session refresh skipped", { err: err instanceof Error ? err.message : String(err) });
    }
    return res;
  }

  let site;
  try {
    site = await siteResolver().resolve(host);
  } catch (err) {
    if (!(err instanceof SiteLookupError)) throw err;
    // We could not determine whether this host is ours. Answering 404 would
    // make a Mode A Worker re-fetch the customer's origin, which would then
    // serve THEIR 404 page for an article that exists. A 503 instead lets
    // stale-if-error and the Worker's mirror fallback do their job, so a blip
    // on our side is invisible on their domain.
    console.error("[aeo] site lookup failed", { host, err });
    return new NextResponse("Temporarily unavailable", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "5" },
    });
  }

  const forwardedHost = req.headers.get(HEADER.forwardedHost);

  const action = decideProxyAction({
    host,
    forwardedHost,
    pathname: req.nextUrl.pathname,
    hops: req.headers.get(HEADER.hops),
    site,
  });

  switch (action.kind) {
    case "loop":
      // 508 rather than a redirect or a retry: something is misconfigured and
      // looping, and the only safe move is to stop and page someone.
      return new NextResponse("Loop detected", {
        status: 508,
        headers: { "cache-control": "no-store" },
      });

    case "passthrough":
      // A Mode A Worker sees this header and re-fetches the customer's own
      // origin, so a path collision means their page wins rather than 404s.
      return new NextResponse(null, {
        status: 404,
        headers: { [HEADER.passthrough]: "1", "cache-control": "public, max-age=10" },
      });

    case "render": {
      const headers = new Headers(req.headers);

      // The blog is same-origin with the customer's site, so the browser sends
      // THEIR session cookies here. Drop them before any handler — or any log
      // sink — can see them. We also never set a cookie on their domain.
      for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);

      // Site config the render handler needs. It runs as a role that can read
      // only content.published_pages, so it cannot resolve these itself.
      headers.set(INTERNAL_HEADER.siteId, action.siteId);
      headers.set(INTERNAL_HEADER.canonicalDomain, action.canonicalDomain);
      headers.set(INTERNAL_HEADER.pathPrefix, action.site.pathPrefix);
      headers.set(INTERNAL_HEADER.locale, action.site.locale);
      headers.set(INTERNAL_HEADER.trailingSlash, action.site.trailingSlash);
      headers.set(INTERNAL_HEADER.indexable, action.indexable ? "1" : "0");

      // A Mode A Worker signs host + path + minute with the site's secret.
      // Verified means "this came through the customer's own proxy", which
      // is what tells us the Worker is already reporting crawl telemetry.
      const secret = action.site.proxyHmacSecret ?? null;
      const signed = secret ? await verifyRequestSignature(secret, forwardedHost ?? "", req.nextUrl.pathname, req.headers.get("x-aeo-sig")) : false;
      headers.set(INTERNAL_HEADER.signed, signed ? "1" : "0");

      // Origin-side crawl telemetry for installs without a Worker (or an
      // unsigned one): partial coverage, misses only, but never nothing.
      // Signed requests are skipped because the Worker reports those itself.
      const bot = classifyUserAgent(req.headers.get("user-agent"));
      if (bot && secret && !signed) {
        event.waitUntil(reportOriginCrawl(req, action.siteId, secret, bot).catch(() => undefined));
      }

      if (action.redirectTo) {
        // The handler emits the 301; see the note on ProxyAction.redirectTo.
        headers.set(INTERNAL_HEADER.redirect, action.redirectTo);
      }

      const url = req.nextUrl.clone();
      url.pathname = action.internalPath;

      const res = NextResponse.rewrite(url, { request: { headers } });
      res.headers.set(HEADER.site, action.siteId);

      if (!action.indexable) {
        // We could not verify which public host this arrived on, so we must not
        // let it be indexed — otherwise we publish a duplicate of the
        // customer's content under a host they may not control.
        res.headers.set("x-robots-tag", "noindex, nofollow");
      }
      return res;
    }
  }
}

/** Fire-and-forget post to our own ingest route, signed like a Worker's would be. */
async function reportOriginCrawl(req: NextRequest, siteId: string, secret: string, bot: { family: string; purpose: string }): Promise<void> {
  const base = process.env.APP_URL || req.nextUrl.origin;
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const body = JSON.stringify({
    siteId,
    events: [
      {
        ts: new Date().toISOString(),
        path: req.nextUrl.pathname,
        botFamily: bot.family,
        purpose: bot.purpose,
        ua: req.headers.get("user-agent"),
        cacheStatus: "MISS",
        country: req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? null,
        ip,
        source: "origin",
      },
    ],
  });
  await fetch(`${base}/api/ingest/crawl`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aeo-site": siteId, "x-aeo-sig": await hmacHex(secret, body) },
    body,
    signal: AbortSignal.timeout(3000),
  });
}
