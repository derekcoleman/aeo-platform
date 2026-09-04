import { createHmac, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Stripe without the SDK: three REST calls and one signature check. Plans are
 * code; price ids are environment. The webhook is the source of truth for
 * plan state — the app never flips a plan on the success redirect alone.
 */

export type PlanKey = "starter" | "pro" | "managed";

export interface PlanSpec {
  key: PlanKey;
  name: string;
  monthlyUsd: number;
  blurb: string;
  includes: string[];
  priceEnv: "STRIPE_PRICE_STARTER" | "STRIPE_PRICE_PRO" | "STRIPE_PRICE_MANAGED";
}

export const PLANS: readonly PlanSpec[] = [
  { key: "starter", name: "Visibility", monthlyUsd: 149, blurb: "Self-serve. Know where you stand in AI answers.", includes: ["AI Overview citation tracking (50 questions)", "Crawler telemetry and live-fetch alerts", "Monthly readiness audit", "GSC and GA4 attribution"], priceEnv: "STRIPE_PRICE_STARTER" },
  { key: "pro", name: "Visibility Pro", monthlyUsd: 299, blurb: "Self-serve, more questions, weekly cadence.", includes: ["250 tracked questions, weekly snapshots", "Competitor citation gap queue", "Brand brain and manifesto", "Everything in Visibility"], priceEnv: "STRIPE_PRICE_PRO" },
  { key: "managed", name: "Managed growth", monthlyUsd: 3000, blurb: "We publish on your domain and prove what moved.", includes: ["3–4 grounded articles a week on your domain", "Reverse-proxy install and health monitoring", "Brief approvals in Slack", "Closed-loop attribution per asset"], priceEnv: "STRIPE_PRICE_MANAGED" },
];

export function planSpec(key: string): PlanSpec | undefined {
  return PLANS.find((p) => p.key === key);
}

export interface StripeEnv {
  [key: string]: string | undefined;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MANAGED?: string;
}

export function stripeConfigured(env: StripeEnv = process.env): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

function form(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function stripePost<T>(path: string, params: Record<string, string | number | undefined>, env: StripeEnv, fetchImpl: typeof fetch): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`stripe ${path}: ${body.error?.message ?? `status ${res.status}`}`);
  return body;
}

export interface CheckoutInput {
  orgId: string;
  plan: PlanKey;
  customerEmail: string | null;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}

/** Hosted Checkout for a subscription. The org id rides in metadata and client_reference_id so the webhook can attribute it. */
export async function createCheckoutSession(input: CheckoutInput, env: StripeEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ id: string; url: string }> {
  const spec = planSpec(input.plan);
  const price = spec ? env[spec.priceEnv] : undefined;
  if (!spec || !price) throw new Error(`no Stripe price configured for plan ${input.plan}`);
  const session = await stripePost<{ id: string; url: string }>(
    "/checkout/sessions",
    {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.orgId,
      "metadata[orgId]": input.orgId,
      "metadata[plan]": input.plan,
      "subscription_data[metadata][orgId]": input.orgId,
      "subscription_data[metadata][plan]": input.plan,
      customer: input.customerId ?? undefined,
      customer_email: input.customerId ? undefined : (input.customerEmail ?? undefined),
      allow_promotion_codes: "true",
    },
    env,
    fetchImpl,
  );
  return { id: session.id, url: session.url };
}

export async function createPortalSession(customerId: string, returnUrl: string, env: StripeEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ url: string }> {
  return stripePost<{ url: string }>("/billing_portal/sessions", { customer: customerId, return_url: returnUrl }, env, fetchImpl);
}

/** `Stripe-Signature: t=…,v1=…` over `${t}.${payload}`; 5-minute tolerance. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, now: number = Date.now(), toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export type PlanStatus = "trialing" | "active" | "past_due" | "canceled" | "paused";

function statusOf(stripeStatus: unknown): PlanStatus {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "paused":
      return "paused";
    default:
      return "canceled";
  }
}

/** Apply one event to the org it names. Unknown types are ignored; unknown orgs are reported, not thrown. */
export async function applyStripeEvent(event: StripeEvent, sql: postgres.Sql = appDb()): Promise<{ applied: boolean; orgId: string | null; change?: string }> {
  const obj = event.data.object;
  const meta = (obj.metadata ?? {}) as Record<string, string>;
  const orgId = meta.orgId ?? (typeof obj.client_reference_id === "string" ? obj.client_reference_id : null);

  if (event.type === "checkout.session.completed") {
    if (!orgId) return { applied: false, orgId: null };
    const customer = typeof obj.customer === "string" ? obj.customer : null;
    const subscription = typeof obj.subscription === "string" ? obj.subscription : null;
    const plan = planSpec(meta.plan ?? "")?.key ?? null;
    const email = (obj.customer_details as { email?: string } | undefined)?.email ?? (typeof obj.customer_email === "string" ? obj.customer_email : null);
    await sql`update app.organizations
      set stripe_customer_id = coalesce(${customer}, stripe_customer_id),
          stripe_subscription_id = coalesce(${subscription}, stripe_subscription_id),
          plan = coalesce(${plan}, plan), plan_status = 'active', billing_email = coalesce(${email}, billing_email)
      where id = ${orgId}`;
    return { applied: true, orgId, change: `plan ${plan ?? "unchanged"} active` };
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = typeof obj.id === "string" ? obj.id : null;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : statusOf(obj.status);
    const plan = planSpec(meta.plan ?? "")?.key ?? null;
    const rows = orgId
      ? await sql<{ id: string }[]>`update app.organizations set plan_status = ${status}, plan = coalesce(${plan}, plan) where id = ${orgId} returning id`
      : await sql<{ id: string }[]>`update app.organizations set plan_status = ${status}, plan = coalesce(${plan}, plan) where stripe_subscription_id = ${subscription} returning id`;
    return { applied: rows.length > 0, orgId: rows[0]?.id ?? orgId, change: `status ${status}` };
  }

  if (event.type === "invoice.payment_failed") {
    const customer = typeof obj.customer === "string" ? obj.customer : null;
    if (!customer) return { applied: false, orgId: null };
    const rows = await sql<{ id: string }[]>`update app.organizations set plan_status = 'past_due' where stripe_customer_id = ${customer} returning id`;
    return { applied: rows.length > 0, orgId: rows[0]?.id ?? null, change: "past_due" };
  }

  return { applied: false, orgId };
}
