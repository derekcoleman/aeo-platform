import type postgres from "postgres";
import { recordWebhookEvent } from "../store";
import type { ConnectionRow } from "../types";
import { parseApprovalAction, parseSlackEvent } from "./events";
import { verifySlackSignature } from "./signature";

/**
 * Inbound Slack traffic, framework-free so it can be tested without Next.
 *
 * The webhook invariant: verify signature → ledger (ops.webhook_events,
 * unique per event) → emit an Inngest event → 200. Nothing is processed
 * inline; Slack retries anything slower than 3s and a duplicate would
 * double-ingest.
 */

export interface InboundDeps {
  signingSecret: string;
  sql: postgres.Sql;
  /** `inngest.send` or a test spy. */
  send: (event: InboundEvent) => Promise<unknown>;
  now?: () => Date;
}

export type InboundEvent =
  | { name: "connector/webhook.received"; data: { provider: "slack"; externalId: string; connectionId: string | null; orgId: string | null; payload: unknown } }
  | {
      name: "approval/decided";
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
      const fresh = await recordWebhookEvent("slack", parsed.eventId, json, deps.sql);
      if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
      const conn = await connectionForTeam(parsed.teamId, deps.sql);
      await deps.send({
        name: "connector/webhook.received",
        data: { provider: "slack", externalId: parsed.eventId, connectionId: conn?.id ?? null, orgId: conn?.org_id ?? null, payload: parsed.message },
      });
      return { status: 200, body: { ok: true } };
    }
  }
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

  const fresh = await recordWebhookEvent("slack", `interaction:${action.externalId}`, payload, deps.sql);
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } };
  const conn = action.teamId ? await connectionForTeam(action.teamId, deps.sql) : null;
  await deps.send({
    name: "approval/decided",
    data: {
      approvalId: action.approvalId,
      decision: action.decision,
      by: { userId: action.userId, name: action.userName },
      source: "slack",
      note: null,
      orgId: conn?.org_id ?? null,
    },
  });
  // An empty 200 leaves the message as-is; the pipeline updates it via decidedBlocks once the gate resolves.
  return { status: 200, body: "" };
}
