import { headers } from "next/headers";
import { INTERNAL_HEADER } from "@/lib/tenancy";
import { routeContext, textResponse } from "@/lib/render/routes";
import { absoluteUrl } from "@/lib/tenancy";

/**
 * We do not proxy the customer's root robots.txt — the blast radius of getting
 * that wrong is their entire site, so onboarding asks them for a single
 * `Sitemap:` line instead.
 *
 * This route exists for one job: when a request reaches us WITHOUT a verified
 * public host, it is a direct hit on our edge hostname. That host must be fully
 * disallowed, or our copy of the customer's content becomes indexable on a
 * third-party domain.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const ctx = await routeContext(siteId);
  if (!ctx) return new Response("Not found", { status: 404 });

  const h = await headers();
  if (h.get(INTERNAL_HEADER.indexable) !== "1") {
    return textResponse("User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8", {
      "cache-control": "public, max-age=300",
    });
  }

  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${absoluteUrl(ctx.host, `${ctx.config.pathPrefix}/sitemap.xml`)}`,
    "",
  ].join("\n");
  return textResponse(body, "text/plain; charset=utf-8");
}
