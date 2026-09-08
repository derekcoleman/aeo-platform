import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AuditError, normalizeTargetUrl } from "@/lib/audit";
import { executeAuditRun } from "@/lib/audit/execute";
import {
  createAuditRun,
  createPublicAudit,
  markAuditFailed,
  recentCompletedRunForDomain,
  recentPublicScansByIp,
} from "@/lib/audit/store";
import { appDatabaseUrl } from "@/lib/db/env";
import { auditRequested, inngest } from "@/lib/inngest/client";
import { inngestConfigured } from "@/lib/jobs/runner";

export const runtime = "nodejs";
// The in-process fallback (no Inngest) runs the crawl after the response is
// sent; it needs the function's full budget, not the default 10s.
export const maxDuration = 300;

/**
 * Public lead-magnet entry point: enqueue an ungated audit of a domain.
 *
 * The work runs in Inngest when the deployment is connected to it (see
 * lib/inngest/audit.ts). When it is not — a fresh deployment, or
 * AEO_JOBS_INLINE=1 — the same job runs in this function after the response
 * via `after()`, so the form still gets a report instead of a row that sits
 * in `queued` forever. Either way this route only validates, rate-limits,
 * dedupes and hands off; clients poll /api/audit/[id].
 *
 * Every failure is a JSON body with an `error` code. The form maps the codes
 * to copy; an HTML 500 would leave it stuck on "Scanning…".
 */
const body = z.object({
  url: z.string().min(1).max(2048),
  email: z.string().email().max(320).optional().nullable(),
  /** Honeypot: real users never fill this in. */
  website: z.string().optional(),
});

const SCANS_PER_IP_PER_HOUR = Number(process.env.AEO_AUDIT_SCANS_PER_IP_PER_HOUR ?? 5);
const REUSE_WINDOW_HOURS = Number(process.env.AEO_AUDIT_REUSE_HOURS ?? 24);

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || null;
}

function runInline(input: { auditRunId: string; targetUrl: string }): void {
  after(async () => {
    try {
      await executeAuditRun({ ...input, kind: "public" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[audit] inline run ${input.auditRunId} failed: ${message}`);
      await markAuditFailed(input.auditRunId, message).catch(() => undefined);
    }
  });
}

export async function POST(req: NextRequest) {
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Bots fill the honeypot; pretend it worked so they don't adapt.
  if (input.website) return NextResponse.json({ id: null, slug: null, queued: false });

  let target: URL;
  try {
    target = normalizeTargetUrl(input.url);
  } catch (err) {
    const code = err instanceof AuditError ? err.code : "invalid_url";
    return NextResponse.json({ error: code }, { status: 400 });
  }
  const domain = target.hostname.replace(/^www\./, "");

  if (!appDatabaseUrl()) {
    console.error("[audit] DATABASE_URL (or POSTGRES_URL) is not set; cannot record the run");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  try {
    const ip = clientIp(req);
    if (ip && (await recentPublicScansByIp(ip)) >= SCANS_PER_IP_PER_HOUR) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "3600" } });
    }

    // A fresh public scan of the same domain is served from the last run rather
    // than re-crawled: the score does not change hour to hour and the crawl is
    // the expensive part. Monitored/preflight audits never take this path.
    const cached = await recentCompletedRunForDomain(domain, REUSE_WINDOW_HOURS);
    if (cached) {
      return NextResponse.json({ id: cached.runId, slug: cached.slug, queued: false, reused: true });
    }

    const id = await createAuditRun({ targetUrl: target.toString(), domain, kind: "public" });
    const slug = await createPublicAudit({ auditRunId: id, domain, email: input.email ?? null, ip });

    let mode: "inngest" | "inline" = "inline";
    if (inngestConfigured()) {
      try {
        await inngest.send(auditRequested.create({ auditRunId: id, targetUrl: target.toString(), kind: "public" }));
        mode = "inngest";
      } catch (e) {
        // Keys present but the event API refused: run here rather than strand the row.
        console.error(`[audit] inngest.send failed, running inline: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (mode === "inline") runInline({ auditRunId: id, targetUrl: target.toString() });

    return NextResponse.json({ id, slug, queued: true, mode }, { status: 202 });
  } catch (e) {
    console.error(`[audit] enqueue failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
