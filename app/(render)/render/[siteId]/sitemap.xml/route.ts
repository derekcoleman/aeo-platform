import { listPublishedPages } from "@/lib/render/published";
import { buildSitemap } from "@/lib/render/artifacts";
import { routeContext, textResponse } from "@/lib/render/routes";

export const dynamic = "force-static";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const ctx = await routeContext(siteId);
  if (!ctx) return new Response("Not found", { status: 404 });

  const pages = await listPublishedPages(siteId, 5000);
  return textResponse(buildSitemap(ctx.host, pages), "application/xml; charset=utf-8");
}
