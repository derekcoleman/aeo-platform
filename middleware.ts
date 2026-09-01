import { NextResponse, type NextRequest } from "next/server";
import {
  HEADER,
  STRIPPED_REQUEST_HEADERS,
  decideProxyAction,
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
  // Everything except our own app surfaces and Next internals. The public
  // render path is the default; app/ops/api are the exceptions.
  matcher: ["/((?!_next/|api/|app/|ops/|favicon.ico|robots.txt$).*)"],
};

export async function middleware(req: NextRequest) {
  const host = req.headers.get("host");

  // Only requests arriving on a per-site edge hostname are public render
  // traffic. Anything else (our own domains, local dev) passes straight
  // through to the app.
  const site = await siteResolver().resolve(host);
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

    case "redirect":
      // Root-relative Location. An absolute one would carry our edge hostname
      // into a customer-visible response.
      return new NextResponse(null, {
        status: 301,
        headers: { location: action.location, "cache-control": "public, max-age=3600" },
      });

    case "render": {
      const headers = new Headers(req.headers);

      // The blog is same-origin with the customer's site, so the browser sends
      // THEIR session cookies here. Drop them before any handler — or any log
      // sink — can see them. We also never set a cookie on their domain.
      for (const h of STRIPPED_REQUEST_HEADERS) headers.delete(h);

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
