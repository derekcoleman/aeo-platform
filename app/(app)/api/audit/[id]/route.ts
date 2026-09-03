import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRun } from "@/lib/audit/store";

export const runtime = "nodejs";

/**
 * Poll endpoint for a queued audit. Public (null-org) runs are addressable
 * by id only — the id is a v4 uuid handed out by POST /api/audit, which is
 * the capability. Org-owned runs are not served here; they go through the
 * authenticated app surface once it exists.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const run = await getAuditRun(id);
  if (!run || run.org_id !== null) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const done = run.status === "completed" || run.status === "failed";
  return NextResponse.json(
    {
      id: run.id,
      status: run.status,
      domain: run.domain,
      geoScore: run.geo_score,
      dimensions: run.dimension_scores,
      degraded: run.degraded,
      pagesAnalyzed: run.pages_analyzed,
      error: run.error,
      result: run.status === "completed" ? run.result : null,
    },
    { headers: { "cache-control": done ? "public, max-age=300" : "no-store" } },
  );
}
