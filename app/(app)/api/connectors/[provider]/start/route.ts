import { NextResponse, type NextRequest } from "next/server";
import { currentUser, canManage } from "@/lib/auth/session";
import { SiteNotInOrgError, assertSiteInOrg, authorizeUrlFor } from "@/lib/connectors/oauth-start";
import { ConnectorError } from "@/lib/connectors/types";

/**
 * Begin an OAuth flow for an org the caller manages, bound to one of that
 * org's sites when a site is named. The signed state carries org, site, user
 * and return path; the callbacks trust only that state, so both are checked
 * here, before it is signed.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "slack" && provider !== "google") return NextResponse.json({ error: "unknown_provider" }, { status: 404 });
  const user = await currentUser();
  const url = new URL(req.url);
  if (!user) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url.origin));
  const orgId = url.searchParams.get("orgId") ?? "";
  const siteId = url.searchParams.get("siteId");
  const returnTo = url.searchParams.get("returnTo");
  if (!canManage(user, orgId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (siteId) {
    try {
      await assertSiteInOrg(siteId, orgId);
    } catch (e) {
      if (e instanceof SiteNotInOrgError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
      throw e;
    }
  }
  try {
    const target = authorizeUrlFor(provider, { orgId, siteId: siteId || null, userId: user.id, returnTo: returnTo && returnTo.startsWith("/") ? returnTo : undefined }, process.env);
    return NextResponse.redirect(target, 303);
  } catch (e) {
    const message = e instanceof ConnectorError || e instanceof Error ? e.message : String(e);
    const back = new URL(returnTo && returnTo.startsWith("/") ? returnTo : "/settings/connectors", url.origin);
    back.searchParams.set("connector", provider);
    back.searchParams.set("error", message);
    return NextResponse.redirect(back, 303);
  }
}
