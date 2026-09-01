import type { SlackApi, SlackResponse } from "./api";
import { encodeApprovalValue, type ApprovalDecision } from "./events";

/**
 * Outbound Block Kit. Approvals are the pipeline's human gate delivered where
 * the customer already works; the buttons carry `{approvalId, decision}` so a
 * click resolves `waitForEvent` with no lookup on our side.
 */

export interface ApprovalMessageInput {
  approvalId: string;
  kind: "brief" | "draft";
  title: string;
  summary: string;
  previewUrl: string;
  /** Extra facts (target question, word count, structure score). */
  facts?: { label: string; value: string }[];
}

type Block = Record<string, unknown>;

export function approvalBlocks(input: ApprovalMessageInput): Block[] {
  const heading = input.kind === "brief" ? "Brief ready for approval" : "Draft ready for approval";
  const button = (text: string, decision: ApprovalDecision, style?: "primary" | "danger") => ({
    type: "button",
    text: { type: "plain_text", text },
    action_id: `approval:${decision}`,
    value: encodeApprovalValue({ approvalId: input.approvalId, decision }),
    ...(style ? { style } : {}),
  });
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: heading } },
    { type: "section", text: { type: "mrkdwn", text: `*<${input.previewUrl}|${escapeMrkdwn(input.title)}>*\n${escapeMrkdwn(input.summary)}` } },
  ];
  if (input.facts?.length) {
    blocks.push({
      type: "section",
      fields: input.facts.slice(0, 10).map((f) => ({ type: "mrkdwn", text: `*${escapeMrkdwn(f.label)}*\n${escapeMrkdwn(f.value)}` })),
    });
  }
  blocks.push({
    type: "actions",
    block_id: `approval:${input.approvalId}`,
    elements: [button("Approve", "approve", "primary"), button("Request changes", "changes"), button("Regenerate", "regenerate", "danger")],
  });
  return blocks;
}

/** Replace the actions block after a decision so the message cannot be clicked twice. */
export function decidedBlocks(original: Block[], decision: ApprovalDecision, by: string): Block[] {
  const label = { approve: "Approved", changes: "Changes requested", regenerate: "Regeneration requested" }[decision];
  return original
    .filter((b) => b.type !== "actions")
    .concat([{ type: "context", elements: [{ type: "mrkdwn", text: `${label} by <@${by}>` }] }]);
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface PostMessageResponse extends SlackResponse { ts?: string; channel?: string }

export async function postMessage(api: SlackApi, channel: string, text: string, blocks?: Block[]): Promise<{ ts: string; channel: string }> {
  const res = await api.call<PostMessageResponse>("chat.postMessage", {
    channel,
    text,
    blocks: blocks ? JSON.stringify(blocks) : undefined,
    unfurl_links: false,
  });
  return { ts: res.ts ?? "", channel: res.channel ?? channel };
}

export async function updateMessage(api: SlackApi, channel: string, ts: string, text: string, blocks?: Block[]): Promise<void> {
  await api.call("chat.update", { channel, ts, text, blocks: blocks ? JSON.stringify(blocks) : undefined });
}
