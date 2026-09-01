import { listPublishedPagesWithMarkdown } from "@/lib/render/published";
import { buildLlmsFullTxt } from "@/lib/render/artifacts";
import { routeContext, textResponse } from "@/lib/render/routes";

export const dynamic = "force-static";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const ctx = await routeContext(siteId);
  if (!ctx) return new Response("Not found", { status: 404 });

  const pages = await listPublishedPagesWithMarkdown(siteId, 2000);
  const { body, truncated } = buildLlmsFullTxt(ctx.host, ctx.config, pages);

  return textResponse(body, "text/plain; charset=utf-8", {
    // Be explicit when the corpus outgrew the cap, rather than silently
    // serving a partial file that looks complete.
    ...(truncated ? { "x-aeo-truncated": "1" } : {}),
  });
}
