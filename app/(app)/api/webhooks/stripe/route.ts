import { NextResponse } from "next/server";
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from "@/lib/billing/stripe";
import { markWebhookProcessed, recordWebhookEvent } from "@/lib/connectors/store";
import { appDb } from "@/lib/db/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same invariant as every webhook here: verify the signature, record the
 * event (unique on provider + id), apply, mark processed, answer fast. A
 * replayed event is a no-op 200.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET not set" }, { status: 503 });
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) return NextResponse.json({ error: "bad signature" }, { status: 400 });
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!event?.id || !event.type) return NextResponse.json({ error: "invalid event" }, { status: 400 });
  const fresh = await recordWebhookEvent("stripe", event.id, event);
  if (!fresh) return NextResponse.json({ ok: true, duplicate: true });
  const result = await applyStripeEvent(event);
  await markWebhookProcessed("stripe", event.id);
  if (result.applied && result.orgId) {
    await appDb()`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
      values (${result.orgId}, null, ${`billing.${event.type}`}, 'organization', ${result.orgId}, ${appDb().json({ change: result.change ?? null, eventId: event.id } as never)})`;
  }
  return NextResponse.json({ ok: true, applied: result.applied });
}
