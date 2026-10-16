import { NextResponse } from "next/server";
import { crawlIngestSchema, insertCrawlEvents, prepareCrawlRows } from "@/lib/analytics/crawl";
import { authenticateIngest, cachedBotRanges, ipHashSalt, noteWorkerVersion } from "@/lib/analytics/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Crawl telemetry from a customer's Worker (Mode A, complete coverage) and
 * from our own middleware (every mode, origin misses only). Signed over the
 * body with the site's secret; unsigned or mis-signed posts are dropped so
 * nobody can inflate a customer's crawler numbers. A Worker's post also says
 * which Worker version it is, which drives the Install tab's upgrade notice.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = crawlIngestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid payload", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });

  const auth = await authenticateIngest(req, raw, parsed.data.siteId);
  if (!auth.ok) return auth.response;

  if (parsed.data.workerVersion) {
    // Bookkeeping only: the crawl rows matter more than the version stamp.
    await noteWorkerVersion(auth.site.id, parsed.data.workerVersion).catch((err) =>
      console.warn("[aeo] worker version not recorded", { siteId: auth.site.id, err: err instanceof Error ? err.message : String(err) }),
    );
  }

  const rows = prepareCrawlRows(parsed.data.events, { ranges: await cachedBotRanges(), salt: ipHashSalt() });
  const accepted = await insertCrawlEvents(auth.site.id, rows);
  return NextResponse.json({ accepted, dropped: parsed.data.events.length - accepted }, { status: 202 });
}
