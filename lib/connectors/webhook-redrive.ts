import type postgres from "postgres";
import { applyAndAuditStripeEvent, type StripeEvent } from "@/lib/billing/stripe";
import { appDb } from "@/lib/db/app";
import { redriveSlackEvent, type InboundEvent } from "./slack/inbound";
import { claimStaleWebhookEvents, markWebhookFailed, markWebhookProcessed, type StaleWebhookEvent, type StaleWebhookOptions } from "./store";

/**
 * The webhook re-drive (cron `webhook-redrive`, every 15 minutes).
 *
 * A route that could not hand a verified event on releases its ledger claim
 * and answers 500. Usually the provider's own retry then delivers it; this
 * catches the rest: Slack interactions (Slack never retries a click), a
 * provider that gave up, a route that died mid-request. Each claimed row is
 * rebuilt from the payload the route stored and delivered exactly as the
 * route would have: a Stripe event is applied, a Slack event is re-sent to
 * Inngest under the same event id (so one that did get through is dropped
 * there). A row that fails again is released with its error for the next
 * run, up to the attempt cap in claimStaleWebhookEvents.
 */

/** The providers whose routes write the ledger. */
export const REDRIVE_PROVIDERS = ["stripe", "slack"] as const;

export interface RedriveDeps {
  send: (event: InboundEvent) => Promise<unknown>;
  sql?: postgres.Sql;
  options?: Omit<StaleWebhookOptions, "providers">;
}

export interface RedriveSummary {
  claimed: number;
  delivered: number;
  dropped: number;
  failed: number;
}

export async function redriveWebhookEvents(deps: RedriveDeps): Promise<RedriveSummary> {
  const sql = deps.sql ?? appDb();
  const rows = await claimStaleWebhookEvents({ ...deps.options, providers: [...REDRIVE_PROVIDERS] }, sql);
  const summary: RedriveSummary = { claimed: rows.length, delivered: 0, dropped: 0, failed: 0 };
  for (const row of rows) {
    try {
      summary[await redriveOne(row, sql, deps.send)]++;
    } catch (e) {
      summary.failed++;
      await markWebhookFailed(row.provider, row.external_id, e, sql);
    }
  }
  return summary;
}

async function redriveOne(row: StaleWebhookEvent, sql: postgres.Sql, send: RedriveDeps["send"]): Promise<"delivered" | "dropped"> {
  if (row.provider === "slack") return redriveSlackEvent(row.external_id, row.payload, { sql, send });
  const event = row.payload as Partial<StripeEvent> | null;
  if (row.provider !== "stripe" || !event?.id || !event.type || !event.data) {
    await markWebhookProcessed(row.provider, row.external_id, sql);
    return "dropped";
  }
  await applyAndAuditStripeEvent(event as StripeEvent, sql);
  await markWebhookProcessed("stripe", row.external_id, sql);
  return "delivered";
}
