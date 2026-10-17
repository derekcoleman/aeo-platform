import { redriveWebhookEvents } from "@/lib/connectors/webhook-redrive";
import { tryRecordHeartbeat } from "@/lib/jobs/heartbeat";
import { sweepSpendReservations } from "@/lib/ops/spend";
import { concurrencyCap, inngest, opsPingRequested } from "./client";

/**
 * The setup checklist's test event. Settings → Deployment sends `ops/ping.requested`
 * with a nonce and records the send; this function records the receipt.
 * Matching nonces prove the whole path: event key → Inngest → this app's
 * sync → a function run → the database.
 */
export const opsPingFunction = inngest.createFunction(
  { id: "ops-ping", triggers: [opsPingRequested], retries: 0 },
  async ({ event, step }) => {
    const recorded = await step.run("record", () => tryRecordHeartbeat("ping:received", { nonce: event.data.nonce, sentAt: event.data.sentAt }));
    return { nonce: event.data.nonce, recorded };
  },
);

/**
 * Every 15 minutes: deliver webhook events whose first hand-off failed
 * (lib/connectors/webhook-redrive.ts). One run at a time, so two runs never
 * claim the same rows; no retries, because the next run is the retry.
 */
export const webhookRedriveFunction = inngest.createFunction(
  { id: "webhook-redrive", triggers: [{ cron: "*/15 * * * *" }], concurrency: [{ limit: concurrencyCap(1) }], retries: 0 },
  async ({ step }) => step.run("redrive", () => redriveWebhookEvents({ send: (e) => inngest.send(e) })),
);

/**
 * Every 15 minutes: give back spend holds whose worker died between reserve
 * and settle (held over 30 minutes), so a crashed call does not keep part of
 * an org's budget, and drop closed holds past retention. A late settle still
 * counts its spend. One run at a time; the next run is the retry.
 */
export const spendReservationSweeperFunction = inngest.createFunction(
  { id: "spend-reservation-sweeper", triggers: [{ cron: "*/15 * * * *" }], concurrency: [{ limit: concurrencyCap(1) }], retries: 0 },
  async ({ step }) => step.run("sweep", () => sweepSpendReservations()),
);

export const opsFunctions = [opsPingFunction, webhookRedriveFunction, spendReservationSweeperFunction];
