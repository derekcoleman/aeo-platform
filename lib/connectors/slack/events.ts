import { z } from "zod";

/**
 * Inbound Slack payload parsing. Two endpoints: the Events API (JSON body)
 * and Interactivity (form-encoded `payload=`). Both are verified with the
 * same signing secret before they get here; this module only classifies.
 */

const urlVerification = z.object({ type: z.literal("url_verification"), challenge: z.string() });

const messageEvent = z.object({
  type: z.literal("message"),
  channel: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
});

const eventCallback = z.object({
  type: z.literal("event_callback"),
  event_id: z.string(),
  team_id: z.string(),
  event: z.union([messageEvent, z.object({ type: z.string() }).passthrough()]),
});

export type SlackEventEnvelope = z.infer<typeof eventCallback>;
export type SlackMessageEvent = z.infer<typeof messageEvent>;

export type ParsedSlackEvent =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; eventId: string; teamId: string; message: SlackMessageEvent }
  | { kind: "ignored"; eventId: string | null; teamId: string | null; reason: string }
  | { kind: "invalid"; reason: string };

/** Message subtypes that are noise for the brand brain. */
export const IGNORED_MESSAGE_SUBTYPES = new Set(["channel_join", "channel_leave", "bot_message", "message_deleted", "channel_topic", "channel_purpose", "channel_name", "pinned_item", "unpinned_item"]);

export function parseSlackEvent(body: unknown): ParsedSlackEvent {
  const uv = urlVerification.safeParse(body);
  if (uv.success) return { kind: "url_verification", challenge: uv.data.challenge };
  const cb = eventCallback.safeParse(body);
  if (!cb.success) return { kind: "invalid", reason: "not an event_callback" };
  const ev = cb.data.event;
  if (ev.type !== "message") return { kind: "ignored", eventId: cb.data.event_id, teamId: cb.data.team_id, reason: `event type ${ev.type}` };
  const msg = messageEvent.safeParse(ev);
  if (!msg.success) return { kind: "ignored", eventId: cb.data.event_id, teamId: cb.data.team_id, reason: "malformed message" };
  if (msg.data.subtype && IGNORED_MESSAGE_SUBTYPES.has(msg.data.subtype)) {
    return { kind: "ignored", eventId: cb.data.event_id, teamId: cb.data.team_id, reason: `subtype ${msg.data.subtype}` };
  }
  if (msg.data.bot_id) return { kind: "ignored", eventId: cb.data.event_id, teamId: cb.data.team_id, reason: "bot message" };
  return { kind: "message", eventId: cb.data.event_id, teamId: cb.data.team_id, message: msg.data };
}

// ── interactivity (Block Kit approvals) ─────────────────────────────────────

export const APPROVAL_DECISIONS = ["approve", "changes", "regenerate"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** What we encode into a button's `value` so the click carries its own routing. */
export const approvalActionValue = z.object({
  approvalId: z.guid(),
  decision: z.enum(APPROVAL_DECISIONS),
});
export type ApprovalActionValue = z.infer<typeof approvalActionValue>;

const blockActions = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }).optional(),
  user: z.object({ id: z.string(), username: z.string().optional(), name: z.string().optional() }),
  trigger_id: z.string().optional(),
  response_url: z.string().optional(),
  channel: z.object({ id: z.string() }).optional(),
  message: z.object({ ts: z.string() }).optional(),
  actions: z.array(z.object({ action_id: z.string(), block_id: z.string().optional(), value: z.string().optional(), action_ts: z.string().optional() })),
});

export interface ParsedApprovalAction {
  approvalId: string;
  decision: ApprovalDecision;
  teamId: string | null;
  userId: string;
  userName: string | null;
  channelId: string | null;
  messageTs: string | null;
  responseUrl: string | null;
  /** Stable id for the webhook ledger: one click, one event. */
  externalId: string;
}

export function encodeApprovalValue(v: ApprovalActionValue): string {
  return JSON.stringify(approvalActionValue.parse(v));
}

export function parseApprovalAction(payload: unknown): ParsedApprovalAction | null {
  const p = blockActions.safeParse(payload);
  if (!p.success) return null;
  const action = p.data.actions.find((a) => a.action_id.startsWith("approval:") && a.value);
  if (!action?.value) return null;
  let parsed: ApprovalActionValue;
  try {
    parsed = approvalActionValue.parse(JSON.parse(action.value));
  } catch {
    return null;
  }
  return {
    approvalId: parsed.approvalId,
    decision: parsed.decision,
    teamId: p.data.team?.id ?? null,
    userId: p.data.user.id,
    userName: p.data.user.username ?? p.data.user.name ?? null,
    channelId: p.data.channel?.id ?? null,
    messageTs: p.data.message?.ts ?? null,
    responseUrl: p.data.response_url ?? null,
    externalId: `${parsed.approvalId}:${p.data.user.id}:${action.action_ts ?? p.data.message?.ts ?? "0"}`,
  };
}
