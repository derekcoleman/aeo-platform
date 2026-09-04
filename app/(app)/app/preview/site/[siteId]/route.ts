import { NextResponse } from "next/server";
import { previewSiteHtml } from "@/lib/app/preview";
import { loadSite } from "@/lib/app/store";
import { currentUser, roleIn } from "@/lib/auth/session";
import type { SiteTheme } from "@/lib/render/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "frame-ancestors 'self'",
};

/**
 * The site's latest article (or a sample) in its theme. Staff may pass a
 * draft theme as base64url JSON in `?theme=` to preview before saving.
 */
export async function GET(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in required", { status: 401 });
  const site = await loadSite(siteId);
  if (!site) return new NextResponse("Not found", { status: 404 });
  if (!roleIn(user, site.org_id)) return new NextResponse("Forbidden", { status: 403 });
  let themeOverride: SiteTheme | null = null;
  const raw = new URL(req.url).searchParams.get("theme");
  if (raw && user.isStaff) {
    try {
      themeOverride = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as SiteTheme;
    } catch {
      return new NextResponse("Bad theme", { status: 400 });
    }
  }
  const html = await previewSiteHtml(siteId, { themeOverride });
  if (!html) return new NextResponse("No render config for this site", { status: 404 });
  return new NextResponse(html, { headers: PREVIEW_HEADERS });
}
