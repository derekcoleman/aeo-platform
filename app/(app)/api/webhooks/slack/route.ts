import { NextResponse } from "next/server";
import { handleSlackEventRequest } from "@/lib/connectors/slack";
import { appDb } from "@/lib/db/app";
import { inngest } from "@/lib/inngest";

export const runtime = "nodejs";

/**
 * Slack Events API. Verify → dedupe in ops.webhook_events → Inngest → 200.
 * Slack retries anything slower than 3s, so nothing is processed inline.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const { status, body } = await handleSlackEventRequest(
    rawBody,
    { signature: req.headers.get("x-slack-signature"), timestamp: req.headers.get("x-slack-request-timestamp"), retryNum: req.headers.get("x-slack-retry-num") },
    { signingSecret: process.env.SLACK_SIGNING_SECRET ?? "", sql: appDb(), send: (e) => inngest.send(e) },
  );
  return NextResponse.json(body, { status });
}
