import { NextResponse } from "next/server";
import { previewVersionHtml } from "@/lib/app/preview";
import { currentUser, roleIn } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "frame-ancestors 'self'",
};

/** A version rendered exactly as the public path would render it, for a signed-in member of its org. */
export async function GET(_req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in required", { status: 401 });
  const preview = await previewVersionHtml(versionId);
  if (!preview) return new NextResponse("Not found", { status: 404 });
  if (!roleIn(user, preview.orgId)) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(preview.html, { headers: PREVIEW_HEADERS });
}
