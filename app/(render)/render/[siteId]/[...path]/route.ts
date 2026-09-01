import { getPublishedPage } from "@/lib/render/published";
import { renderArticleDocument, renderArticleMarkdown } from "@/lib/render/document";
import { routeContext, textResponse } from "@/lib/render/routes";

/**
 * The public article route.
 *
 * A route handler rather than a page component, because an App Router page
 * injects the Next client runtime into every response and this page's whole
 * value is that it needs no JavaScript. See lib/render/document.ts.
 *
 * Also serves the `.md` variant: agent fetchers increasingly prefer markdown,
 * and both `rel="alternate"` and llms.txt advertise it.
 */
export const dynamic = "force-static";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string; path: string[] }> }) {
  const { siteId, path } = await params;
  const ctx = await routeContext(siteId);
  if (!ctx) return notFound();

  const segments = [...path];
  const last = segments[segments.length - 1] ?? "";
  const wantsMarkdown = last.endsWith(".md");
  if (wantsMarkdown) segments[segments.length - 1] = last.slice(0, -3);

  const slug = segments[segments.length - 1] ?? "";
  const publicPath = `${ctx.config.pathPrefix}${segments.length ? `/${segments.join("/")}` : ""}`;

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

/**
 * A miss here is a path we do not serve, so it carries the passthrough marker:
 * a Mode A Worker re-fetches the customer's own origin, and a path collision
 * degrades to "their page wins" rather than "their page is gone".
 */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "x-aeo-passthrough": "1", "cache-control": "public, max-age=10" },
  });
}
