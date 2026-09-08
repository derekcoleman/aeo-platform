import { NextResponse } from "next/server";
import { z } from "zod";
import { staleAuditError } from "@/lib/audit/execute";
import { getAuditRun, markAuditFailed } from "@/lib/audit/store";
import { appDatabaseUrl } from "@/lib/db/env";

export const runtime = "nodejs";

/**
 * Poll endpoint for a queued audit. Public (null-org) runs are addressable
 * by id only — the id is a v4 uuid handed out by POST /api/audit, which is
 * the capability. Org-owned runs are not served here; they go through the
 * authenticated app surface.
 *
 * A run that has sat in `queued` or `running` past the stale windows is
 * marked failed here so a client never polls a lost job forever.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!appDatabaseUrl()) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  let run;
  try {
    run = await getAuditRun(id);
  } catch (e) {
    console.error(`[audit] poll failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!run || run.org_id !== null) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const stale = staleAuditError(run);
  if (stale) {
    await markAuditFailed(run.id, stale).catch(() => undefined);
    run = { ...run, status: "failed", error: stale };
  }

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
