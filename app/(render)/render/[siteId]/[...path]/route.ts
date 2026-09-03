import { headers } from "next/headers";
import { ARTIFACTS, HEADER, INTERNAL_HEADER, absoluteUrl, artifactFor } from "@/lib/tenancy";
import {
  getPublishedPage,
  listPublishedPages,
  listPublishedPagesWithMarkdown,
} from "@/lib/render/published";
import { renderArticleDocument, renderArticleMarkdown } from "@/lib/render/document";
import { buildFeed, buildLlmsFullTxt, buildLlmsTxt, buildSitemap } from "@/lib/render/artifacts";
import { routeContext, textResponse, type RouteContext } from "@/lib/render/routes";

/**
 * Everything on the public render path.
 *
 * A single catch-all rather than one route file per artifact, because the
 * internal path carries the tenant's own content prefix — which varies per site
 * — so `/render/{id}/resources/sitemap.xml` can never match a static
 * `/render/[siteId]/sitemap.xml` route. Dispatching on the final segment keeps
 * the artifacts reachable through the proxy, and makes those filenames reserved
 * slugs, which is the correct trade.
 *
 * Route handlers, not page components: an App Router page injects the Next
 * client runtime into every response, and these pages' whole value is that they
 * need no JavaScript. See lib/render/document.ts.
 *
 * Dynamic, not prerendered: responses depend on the forwarded host, which
 * decides the canonical URL and whether the page may be indexed. Caching lives
 * where it belongs for this architecture — our Cloudflare edge and the
 * customer's CDN, via the headers textResponse sets.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string; path: string[] }> },
) {
  const { siteId, path } = await params;
  const h = await headers();

  // Trailing-slash normalisation is decided in middleware but emitted here:
  // Next's middleware runtime parses `Location` as an absolute URL and throws
  // on a relative one, and relative is exactly what we need — an absolute
  // Location would carry our edge hostname into a customer-visible response.
  const redirectTo = h.get(INTERNAL_HEADER.redirect);
  if (redirectTo) {
    return new Response(null, {
      status: 301,
      headers: { location: redirectTo, "cache-control": "public, max-age=3600" },
    });
  }

  const ctx = await routeContext(siteId);
  if (!ctx) return notFound();

  const segments = [...path];
  const last = segments[segments.length - 1] ?? "";

  const artifact = artifactFor(last);
  if (artifact) return renderArtifact(artifact, siteId, ctx, h.get(INTERNAL_HEADER.indexable) === "1", siteId, new URL(req.url).searchParams.get("nonce"));

  // The root-level llms paths customers rewrite to us separately.
  if (last === "llms.txt" || last === "llms-full.txt") {
    return renderArtifact(last === "llms.txt" ? "llms" : "llmsFull", siteId, ctx, true, siteId);
  }

  return renderArticle(siteId, ctx, segments, last);
}

async function renderArticle(
  siteId: string,
  ctx: RouteContext,
  segments: string[],
  last: string,
): Promise<Response> {
  const wantsMarkdown = last.endsWith(".md");
  if (wantsMarkdown) segments[segments.length - 1] = last.slice(0, -3);

  const slug = segments[segments.length - 1] ?? "";
  // The internal path already carries the site's public prefix, so these
  // segments ARE the public path. Re-prepending it would look up
  // /resources/resources/slug.
  const publicPath = `/${segments.join("/")}`;

  const page = await getPublishedPage(siteId, publicPath);
  if (!page) return notFound();

  const input = { config: ctx.config, host: ctx.host, page, slug };

  if (wantsMarkdown) {
    if (!page.markdown) return notFound();
    return textResponse(renderArticleMarkdown(input), "text/markdown; charset=utf-8", {
      etag: `"${page.etag}-md"`,
    });
  }
  return textResponse(renderArticleDocument(input), "text/html; charset=utf-8", {
    etag: `"${page.etag}"`,
  });
}

async function renderArtifact(
  kind: keyof typeof ARTIFACTS,
  siteId: string,
  ctx: RouteContext,
  indexable: boolean,
  siteIdForHeader: string,
  nonce: string | null = null,
): Promise<Response> {
  switch (kind) {
    case "sitemap":
      return textResponse(
        buildSitemap(ctx.host, await listPublishedPages(siteId, 5000)),
        "application/xml; charset=utf-8",
      );

    case "feed":
      return textResponse(
        buildFeed(ctx.host, ctx.config, await listPublishedPages(siteId, 200)),
        "application/atom+xml; charset=utf-8",
      );

    case "llms":
      return textResponse(
        buildLlmsTxt(ctx.host, ctx.config, await listPublishedPages(siteId, 2000)),
        "text/plain; charset=utf-8",
      );

    case "llmsFull": {
      const { body, truncated } = buildLlmsFullTxt(
        ctx.host,
        ctx.config,
        await listPublishedPagesWithMarkdown(siteId, 2000),
      );
      // Be explicit when the corpus outgrew the cap rather than serving a
      // partial file that looks complete.
      return textResponse(body, "text/plain; charset=utf-8", truncated ? { "x-aeo-truncated": "1" } : {});
    }

    case "robots":
      return renderRobots(ctx, indexable);

    case "health":
      return renderHealth(ctx, siteIdForHeader, nonce);
  }
}

/**
 * We do not proxy the customer's root robots.txt — the blast radius of getting
 * that wrong is their entire site. This route exists for one job: a request
 * without a verified public host is a direct hit on our edge hostname, and that
 * host must be fully disallowed, or our copy of the customer's content becomes
 * indexable on a third-party domain.
 */
function renderRobots(ctx: RouteContext, indexable: boolean): Response {
  if (!indexable) {
    return textResponse("User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8", {
      "cache-control": "public, max-age=300",
    });
  }
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${absoluteUrl(ctx.host, `${ctx.config.pathPrefix}/${ARTIFACTS.sitemap}`)}`,
    "",
  ].join("\n");
  return textResponse(body, "text/plain; charset=utf-8");
}

/**
 * Install verification and continuous health. Echoes what we actually received
 * so a health checker can tell a working install from a subtly broken one — the
 * common failure is a customer changing their own edge config months later and
 * nobody noticing for weeks.
 */
async function renderHealth(ctx: RouteContext, siteId: string, nonce: string | null): Promise<Response> {
  const h = await headers();
  return Response.json(
    {
      ok: true,
      siteId,
      // Echoed verbatim (bounded) so the monitor can tell a live answer from a
      // cached one — the health path is no-store, but a customer edge may not honour that.
      nonce: nonce ? nonce.slice(0, 64) : null,
      canonicalDomain: ctx.config.canonicalDomain,
      pathPrefix: ctx.config.pathPrefix,
      received: {
        // If forwardedHost is null their rewrite is not setting it, which means
        // every page we serve them is noindex — worth surfacing loudly.
        forwardedHost: h.get(HEADER.forwardedHost),
        hops: h.get(HEADER.hops),
        indexable: h.get(INTERNAL_HEADER.indexable) === "1",
        // Proves cookie stripping works end to end. Must always be false.
        sawCookie: h.get("cookie") !== null,
        sawAuthorization: h.get("authorization") !== null,
      },
      at: new Date().toISOString(),
    },
    { headers: { [HEADER.site]: siteId, "cache-control": "no-store" } },
  );
}

/**
 * A miss carries the passthrough marker: a Mode A Worker re-fetches the
 * customer's own origin, so a path collision degrades to "their page wins"
 * rather than "their page is gone".
 */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { [HEADER.passthrough]: "1", "cache-control": "public, max-age=10" },
  });
}
