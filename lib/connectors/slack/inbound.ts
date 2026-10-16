import type postgres from "postgres";
import { claimWebhookEvent, markWebhookFailed, markWebhookProcessed } from "../store";
import type { ConnectionRow } from "../types";
import { parseApprovalAction, parseSlackEvent, type ParsedApprovalAction, type SlackMessageEvent } from "./events";
import { verifySlackSignature } from "./signature";

/**
 * Inbound Slack traffic, framework-free so it can be tested without Next.
 *
 * The webhook invariant: verify signature → claim the ledger row
 * (ops.webhook_events, unique per event) → emit an Inngest event → 200.
 * Nothing is processed inline; Slack retries anything slower than 3s and a
 * duplicate would double-ingest. When the emit fails the claim is released
 * and the answer is 500, so Slack's retry — or the webhook-redrive cron, for
 * interactions Slack does not retry — delivers it instead of losing it. The
 * emitted event carries the ledger id as its Inngest id, so a re-send of an
 * event that did get through is dropped there.
 */

export interface InboundDeps {
  signingSecret: string;
  sql: postgres.Sql;
  /** `inngest.send` or a test spy. */
  send: (event: InboundEvent) => Promise<unknown>;
  now?: () => Date;
}

export type InboundEvent =
  | { name: "connector/webhook.received"; id: string; data: { provider: "slack"; externalId: string; connectionId: string | null; orgId: string | null; payload: unknown } }
  | {
      name: "approval/decided";
      id: string;
      data: {
        approvalId: string;
        decision: "approve" | "changes" | "regenerate";
        by: { userId: string | null; name: string | null };
        source: "slack";
        note: string | null;
        orgId: string | null;
      };
    };

export interface InboundResult {
  status: number;
  body: unknown;
}

export interface InboundHeaders {
  signature: string | null;
  timestamp: string | null;
  /** Slack sets X-Slack-Retry-Num on redeliveries; the ledger makes them no-ops. */
  retryNum?: string | null;
}

/** The connection a workspace's events route to. Slack's team id is the connection's external_account_id. */
export async function connectionForTeam(teamId: string, sql: postgres.Sql): Promise<Pick<ConnectionRow, "id" | "org_id"> | null> {
  const [row] = await sql<Pick<ConnectionRow, "id" | "org_id">[]>`
    select id, org_id from context.context_connections
    where provider = 'slack' and external_account_id = ${teamId} and enabled and status <> 'disconnected'
    order by created_at desc limit 1`;
  return row ?? null;
}

export async function handleSlackEventRequest(rawBody: string, headers: InboundHeaders, deps: InboundDeps): Promise<InboundResult> {
  if (!verifySlackSignature({ signingSecret: deps.signingSecret, timestamp: headers.timestamp, body: rawBody, signature: headers.signature, now: deps.now?.() })) {
    return { status: 401, body: { error: "bad_signature" } };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const parsed = parseSlackEvent(json);
  switch (parsed.kind) {
    case "url_verification":
      return { status: 200, body: { challenge: parsed.challenge } };
    case "invalid":
      return { status: 400, body: { error: "invalid_event" } };
    case "ignored":
      return { status: 200, body: { ok: true, ignored: parsed.reason } };
    case "message": {
      const fresh = await claimWebhookEvent("slack", parsed.eventId, json, deps.sql);
      if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
      try {
        await emitMessage(parsed, deps);
      } catch (e) {
        // The connector-webhook function marks the row processed once it has
        // the event; until the emit succeeds there is nothing to mark.
        await markWebhookFailed("slack", parsed.eventId, e, deps.sql);
        return { status: 500, body: { error: "delivery_failed" } };
      }
      return { status: 200, body: { ok: true } };
    }
  }
}

/** The Inngest id for a ledgered event: one delivery, one run, however often it is re-sent. */
const inngestIdFor = (externalId: string) => `webhook:slack:${externalId}`;

async function emitMessage(parsed: { eventId: string; teamId: string; message: SlackMessageEvent }, deps: Pick<InboundDeps, "sql" | "send">): Promise<void> {
  const conn = await connectionForTeam(parsed.teamId, deps.sql);
  await deps.send({
    name: "connector/webhook.received",
    id: inngestIdFor(parsed.eventId),
    data: { provider: "slack", externalId: parsed.eventId, connectionId: conn?.id ?? null, orgId: conn?.org_id ?? null, payload: parsed.message },
  });
}

/** The ledger id of an approval click. */
const interactionLedgerId = (action: ParsedApprovalAction) => `interaction:${action.externalId}`;

async function emitApproval(action: ParsedApprovalAction, deps: Pick<InboundDeps, "sql" | "send">): Promise<void> {
  const conn = action.teamId ? await connectionForTeam(action.teamId, deps.sql) : null;
  await deps.send({
    name: "approval/decided",
    id: inngestIdFor(interactionLedgerId(action)),
    data: {
      approvalId: action.approvalId,
      decision: action.decision,
      by: { userId: action.userId, name: action.userName },
      source: "slack",
      note: null,
      orgId: conn?.org_id ?? null,
    },
  });
}

/**
 * Deliver a ledgered Slack event again (webhook-redrive), from the payload
 * the route stored. An approval click is marked processed once its event is
 * sent; a message is marked by the connector-webhook function that receives
 * it, as on the first delivery; anything that no longer parses as either is
 * marked processed and dropped. Throws when the send fails; the caller
 * releases the claim.
 */
export async function redriveSlackEvent(externalId: string, payload: unknown, deps: Pick<InboundDeps, "sql" | "send">): Promise<"delivered" | "dropped"> {
  if (externalId.startsWith("interaction:")) {
    const action = parseApprovalAction(payload);
    if (action && interactionLedgerId(action) === externalId) {
      await emitApproval(action, deps);
      await markWebhookProcessed("slack", externalId, deps.sql);
      return "delivered";
    }
  } else {
    const parsed = parseSlackEvent(payload);
    if (parsed.kind === "message" && parsed.eventId === externalId) {
      await emitMessage(parsed, deps);
      return "delivered";
    }
  }
  await markWebhookProcessed("slack", externalId, deps.sql);
  return "dropped";
}

/** Interactive components arrive form-encoded with the JSON under `payload`. */
export async function handleSlackInteractionRequest(rawBody: string, headers: InboundHeaders, deps: InboundDeps): Promise<InboundResult> {
  if (!verifySlackSignature({ signingSecret: deps.signingSecret, timestamp: headers.timestamp, body: rawBody, signature: headers.signature, now: deps.now?.() })) {
    return { status: 401, body: { error: "bad_signature" } };
  }
  const payloadText = new URLSearchParams(rawBody).get("payload");
  if (!payloadText) return { status: 400, body: { error: "missing_payload" } };
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const action = parseApprovalAction(payload);
  if (!action) return { status: 200, body: { ok: true, ignored: "not an approval action" } };

  const ledgerId = interactionLedgerId(action);
  const fresh = await claimWebhookEvent("slack", ledgerId, payload, deps.sql);
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  try {
    await emitApproval(action, deps);
  } catch (e) {
    // Slack does not retry interactions; webhook-redrive picks the click up.
    await markWebhookFailed("slack", ledgerId, e, deps.sql);
    return { status: 500, body: { error: "delivery_failed" } };
  }
  // Nothing downstream marks an interaction, so the hand-off is the end of the ledger's job.
  await markWebhookProcessed("slack", ledgerId, deps.sql);
  // An empty 200 leaves the message as-is; the pipeline updates it via decidedBlocks once the gate resolves.
  return { status: 200, body: "" };
}
