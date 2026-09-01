import { headers } from "next/headers";
import { HEADER, INTERNAL_HEADER } from "@/lib/tenancy";
import { routeContext } from "@/lib/render/routes";

/**
 * Install verification and continuous health.
 *
 * Reachable at `{customer-domain}{prefix}/aeo-health` once their proxy is in
 * place. Echoes back what we actually received so the health checker can tell
 * a working install from a subtly broken one — the common failure is a customer
 * changing their own edge config months later and nobody noticing for weeks.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const ctx = await routeContext(siteId);
  if (!ctx) return new Response("Not found", { status: 404 });

  const h = await headers();
  return Response.json(
    {
      ok: true,
      siteId,
      canonicalDomain: ctx.config.canonicalDomain,
      pathPrefix: ctx.config.pathPrefix,
      // What the proxy actually forwarded. If `forwardedHost` is null the
      // customer's rewrite is not setting it, which means every page we serve
      // them is noindex — worth surfacing loudly during onboarding.
      received: {
        forwardedHost: h.get(HEADER.forwardedHost),
        hops: h.get(HEADER.hops),
        indexable: h.get(INTERNAL_HEADER.indexable) === "1",
        // Proves cookie stripping is working end to end. Must always be false.
        sawCookie: h.get("cookie") !== null,
        sawAuthorization: h.get("authorization") !== null,
      },
      at: new Date().toISOString(),
    },
    { headers: { [HEADER.site]: siteId, "cache-control": "no-store" } },
  );
}
