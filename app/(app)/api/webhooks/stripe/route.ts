import { NextResponse } from "next/server";
import { applyAndAuditStripeEvent, verifyStripeSignature, type StripeEvent } from "@/lib/billing/stripe";
import { claimWebhookEvent, markWebhookFailed, markWebhookProcessed } from "@/lib/connectors/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same invariant as every webhook here: verify the signature, claim the
 * event's ledger row (unique on provider + id), apply, mark processed, answer
 * fast. A replay of a processed event is a no-op 200. When applying fails the
 * claim is released with the error and the answer is 500, so Stripe's retry
 * (or the webhook-redrive cron) applies it later instead of the ledger
 * swallowing it as a duplicate.
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
  const claimed = await claimWebhookEvent("stripe", event.id, event);
  if (!claimed) return NextResponse.json({ ok: true, duplicate: true });
  try {
    const result = await applyAndAuditStripeEvent(event);
    await markWebhookProcessed("stripe", event.id);
    return NextResponse.json({ ok: true, applied: result.applied });
  } catch (e) {
    console.error("[aeo] stripe event not applied", { eventId: event.id, type: event.type, err: e instanceof Error ? e.message : String(e) });
    await markWebhookFailed("stripe", event.id, e);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
