import { tryRecordHeartbeat } from "@/lib/jobs/heartbeat";
import { inngest, opsPingRequested } from "./client";

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

export const opsFunctions = [opsPingFunction];
