import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { AuditError, normalizeTargetUrl } from "@/lib/audit";
import {
  createAuditRun,
  createPublicAudit,
  recentCompletedRunForDomain,
  recentPublicScansByIp,
} from "@/lib/audit/store";
import { auditRequested, inngest } from "@/lib/inngest/client";

export const runtime = "nodejs";

/**
 * Public lead-magnet entry point: enqueue an ungated audit of a domain.
 *
 * The work itself runs in Inngest (see lib/inngest/audit.ts) — a 24-page
 * crawl with LLM scoring does not fit a serverless request. This route only
 * validates, rate-limits, dedupes and enqueues; clients poll /api/audit/[id].
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
  await inngest.send(auditRequested.create({ auditRunId: id, targetUrl: target.toString(), kind: "public" }));

  return NextResponse.json({ id, slug, queued: true }, { status: 202 });
}
