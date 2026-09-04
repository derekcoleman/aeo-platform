import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyStripeEvent, createCheckoutSession, planSpec, verifyStripeSignature } from "@/lib/billing/stripe";
import { fakeSql } from "./helpers/fake-sql";

const SECRET = "whsec_test";
const ORG = "11111111-1111-1111-1111-111111111111";

function sign(payload: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex")}`;
}

describe("verifyStripeSignature", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "x" });
  const now = 1_800_000_000_000;
  it("accepts a fresh, correctly signed payload and rejects everything else", () => {
    expect(verifyStripeSignature(payload, sign(payload, now / 1000), SECRET, now)).toBe(true);
    expect(verifyStripeSignature(payload + " ", sign(payload, now / 1000), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload, now / 1000 - 600), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload, now / 1000), "other", now)).toBe(false);
    expect(verifyStripeSignature(payload, null, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(payload, "t=abc,v1=zz", SECRET, now)).toBe(false);
  });
});

describe("applyStripeEvent", () => {
  it("activates the plan from checkout metadata", async () => {
    const sql = fakeSql();
    const r = await applyStripeEvent({ id: "evt_1", type: "checkout.session.completed", data: { object: { customer: "cus_1", subscription: "sub_1", metadata: { orgId: ORG, plan: "pro" }, customer_details: { email: "a@b.co" } } } }, sql);
    expect(r).toMatchObject({ applied: true, orgId: ORG });
    expect(sql.queries[0]!.text).toContain("plan_status = 'active'");
    expect(sql.queries[0]!.values).toEqual(["cus_1", "sub_1", "pro", "a@b.co", ORG]);
  });
  it("maps subscription status and finds the org by subscription id when metadata is missing", async () => {
    const sql = fakeSql([[/update app\.organizations/, () => [{ id: ORG }]]]);
    const r = await applyStripeEvent({ id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1", status: "past_due", metadata: {} } } }, sql);
    expect(r).toMatchObject({ applied: true, orgId: ORG, change: "status past_due" });
    expect(sql.queries[0]!.values).toContain("sub_1");
    const del = await applyStripeEvent({ id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_1", metadata: { orgId: ORG } } } }, sql);
    expect(del.change).toBe("status canceled");
  });
  it("ignores unrelated events", async () => {
    const sql = fakeSql();
    expect((await applyStripeEvent({ id: "evt_4", type: "charge.succeeded", data: { object: {} } }, sql)).applied).toBe(false);
    expect(sql.queries).toHaveLength(0);
  });
});

describe("createCheckoutSession", () => {
  it("posts a subscription checkout with the org in metadata", async () => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body), auth: String((init?.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200 });
    }) as typeof fetch;
    const env = { STRIPE_SECRET_KEY: "sk_test", STRIPE_PRICE_PRO: "price_pro" };
    const s = await createCheckoutSession({ orgId: ORG, plan: "pro", customerEmail: "a@b.co", customerId: null, successUrl: "https://x/ok", cancelUrl: "https://x/no" }, env, fetchImpl);
    expect(s.url).toContain("checkout.stripe.com");
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0]!.auth).toBe("Bearer sk_test");
    expect(calls[0]!.body).toContain("mode=subscription");
    expect(calls[0]!.body).toContain(`metadata%5BorgId%5D=${ORG}`);
    expect(calls[0]!.body).toContain("line_items%5B0%5D%5Bprice%5D=price_pro");
    expect(calls[0]!.body).toContain("customer_email=a%40b.co");
  });
  it("refuses a plan without a configured price", async () => {
    await expect(createCheckoutSession({ orgId: ORG, plan: "managed", customerEmail: null, customerId: null, successUrl: "a", cancelUrl: "b" }, { STRIPE_SECRET_KEY: "sk" })).rejects.toThrow(/no Stripe price/);
    expect(planSpec("nope")).toBeUndefined();
  });
});
