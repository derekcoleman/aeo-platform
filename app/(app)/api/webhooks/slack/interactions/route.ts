import { NextResponse } from "next/server";
import { handleSlackInteractionRequest } from "@/lib/connectors/slack";
import { appDb } from "@/lib/db/app";
import { inngest } from "@/lib/inngest";

export const runtime = "nodejs";

/** Block Kit actions (approve / changes / regenerate). Resolves the pipeline's waitForEvent via `approval/decided`. */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const { status, body } = await handleSlackInteractionRequest(
    rawBody,
    { signature: req.headers.get("x-slack-signature"), timestamp: req.headers.get("x-slack-request-timestamp") },
    { signingSecret: process.env.SLACK_SIGNING_SECRET ?? "", sql: appDb(), send: (e) => inngest.send(e) },
  );
  if (body === null || body === undefined) return new NextResponse("", { status });
  return NextResponse.json(body, { status });
}
