"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { opsPingRequested } from "@/lib/inngest";
import { queueJob } from "@/lib/jobs/dispatch";
import { tryRecordHeartbeat } from "@/lib/jobs/heartbeat";

/**
 * Ops → Setup → "Send a test event". Records the send (with the nonce and any
 * refusal) so the checklist can report the round trip; the ops-ping function
 * records the receipt. Never throws: a refused send is a row on the page.
 */
export async function sendJobsPing(): Promise<void> {
  await requireStaff();
  const nonce = randomUUID();
  const error = await queueJob(opsPingRequested.create({ nonce, sentAt: new Date().toISOString() }), undefined, "test event");
  await tryRecordHeartbeat("ping:sent", { nonce, error });
  revalidatePath("/ops/setup");
}
