import { NextResponse } from "next/server";
import { insertSiteAlert, siteAlertSchema } from "@/lib/analytics/crawl";
import { authenticateIngest } from "@/lib/analytics/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What a customer's Worker reports back: a site-id mismatch (it refused to
 * serve someone else's content), a loop, our origin erroring, the mirror
 * being served. These are the failure modes we cannot observe from our side.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = siteAlertSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const auth = await authenticateIngest(req, raw, parsed.data.siteId);
  if (!auth.ok) return auth.response;

  await insertSiteAlert(auth.site.id, { kind: parsed.data.kind, path: parsed.data.path ?? null, detail: parsed.data.detail });
  console.warn("[aeo] edge alert", { siteId: auth.site.id, kind: parsed.data.kind, path: parsed.data.path ?? null });
  return NextResponse.json({ ok: true }, { status: 202 });
}
