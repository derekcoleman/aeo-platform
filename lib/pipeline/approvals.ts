import { listConnections } from "@/lib/connectors/store";
import { approvalBlocks, decidedBlocks, postMessage, slackClientFor, slackTokenFor, updateMessage, type SlackConfig } from "@/lib/connectors/slack";
import type { ConnectorContext } from "@/lib/connectors/types";
import { appDb } from "@/lib/db/app";
import type postgres from "postgres";
import type { ApprovalDecision, ApprovalPolicy } from "./types";

/**
 * The human gate. Policy decides which gates exist; a row per gate holds the
 * decision and, when Slack is connected with an approvals channel, where the
 * Block Kit message lives so the decision can rewrite it.
 */

export type ApprovalKind = "brief" | "draft";

export function requiredGates(policy: ApprovalPolicy): ApprovalKind[] {
  switch (policy) {
    case "auto_publish":
      return [];
    case "approve_brief":
      return ["brief"];
    case "approve_post":
      return ["draft"];
    case "approve_both":
      return ["brief", "draft"];
  }
}

export async function loadApprovalPolicy(siteId: string, sql: postgres.Sql = appDb()): Promise<ApprovalPolicy> {
  const [row] = await sql<{ approval_policy: ApprovalPolicy }[]>`select approval_policy from app.sites where id = ${siteId}`;
  if (!row) throw new Error(`site ${siteId} not found`);
  return row.approval_policy;
}

export interface ApprovalRow {
  id: string;
  org_id: string;
  site_id: string;
  kind: ApprovalKind;
  brief_id: string | null;
  content_version_id: string | null;
  status: "pending" | ApprovalDecision | "expired";
  slack_channel: string | null;
  slack_ts: string | null;
  expires_at: Date | null;
}

export async function createApproval(
  input: { siteId: string; kind: ApprovalKind; briefId?: string | null; contentVersionId?: string | null; expiresAt?: Date | null },
  sql: postgres.Sql = appDb(),
): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into content.approvals (site_id, kind, brief_id, content_version_id, expires_at)
    values (${input.siteId}, ${input.kind}, ${input.briefId ?? null}, ${input.contentVersionId ?? null}, ${input.expiresAt ?? null})
    returning id`;
  if (!row) throw new Error("approval insert returned no row");
  return row;
}

export async function loadApproval(id: string, sql: postgres.Sql = appDb()): Promise<ApprovalRow | null> {
  const [row] = await sql<ApprovalRow[]>`
    select id, org_id, site_id, kind, brief_id, content_version_id, status, slack_channel, slack_ts, expires_at
    from content.approvals where id = ${id}`;
  return row ?? null;
}

export interface DecisionInput {
  decision: ApprovalDecision;
  by: { userId?: string | null; name?: string | null };
  source: "slack" | "app" | "ops";
  note?: string | null;
}

/** First decision wins; a second click on a stale Slack message is a no-op that reports `applied: false`. */
export async function recordDecision(approvalId: string, input: DecisionInput, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<{ applied: boolean }> {
  const rows = await sql<{ id: string }[]>`
    update content.approvals set
      status = ${input.decision}, decided_at = ${now}, decided_by = ${sql.json(input.by as never)},
      source = ${input.source}, note = ${input.note ?? null}
    where id = ${approvalId} and status = 'pending'
    returning id`;
  return { applied: rows.length > 0 };
}

export async function expireApproval(approvalId: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<{ applied: boolean }> {
  const rows = await sql<{ id: string }[]>`
    update content.approvals set status = 'expired', decided_at = ${now}
    where id = ${approvalId} and status = 'pending' returning id`;
  return { applied: rows.length > 0 };
}

// ── Slack delivery ─────────────────────────────────────────────────────────

export interface ApprovalNotice {
  approvalId: string;
  kind: ApprovalKind;
  title: string;
  summary: string;
  previewUrl: string;
  facts?: { label: string; value: string }[];
}

/** The org's active Slack connection that has opted into approvals, if any. Approvals are opt-in per channel, like ingest. */
export async function approvalsSlackTarget(orgId: string, sql: postgres.Sql = appDb()) {
  const conns = await listConnections({ orgId, provider: "slack", activeOnly: true }, sql);
  for (const c of conns) {
    const channel = (c.config as Partial<SlackConfig>).approvalsChannel;
    if (channel) return { conn: c, channel };
  }
  return null;
}

/** Post the Block Kit gate to Slack and remember where it landed. No Slack → nothing posted; the app UI is always a path. */
export async function notifyApprovalSlack(orgId: string, notice: ApprovalNotice, ctx: ConnectorContext): Promise<{ posted: boolean; channel?: string; ts?: string }> {
  const target = await approvalsSlackTarget(orgId, ctx.sql);
  if (!target) return { posted: false };
  const api = slackClientFor(target.conn, await slackTokenFor(target.conn, ctx), ctx);
  const text = `${notice.kind === "brief" ? "Brief" : "Draft"} ready for approval: ${notice.title}`;
  const { ts, channel } = await postMessage(api, target.channel, text, approvalBlocks(notice));
  await ctx.sql`update content.approvals set slack_channel = ${channel}, slack_ts = ${ts} where id = ${notice.approvalId}`;
  return { posted: true, channel, ts };
}

/** Rewrite the posted message so it cannot be clicked twice. Safe to call when nothing was posted. */
export async function updateSlackDecision(approval: ApprovalRow, decision: ApprovalDecision, by: string, notice: ApprovalNotice, ctx: ConnectorContext): Promise<boolean> {
  if (!approval.slack_channel || !approval.slack_ts) return false;
  const target = await approvalsSlackTarget(approval.org_id, ctx.sql);
  if (!target) return false;
  const api = slackClientFor(target.conn, await slackTokenFor(target.conn, ctx), ctx);
  const label = { approve: "Approved", changes: "Changes requested", regenerate: "Regeneration requested" }[decision];
  await updateMessage(api, approval.slack_channel, approval.slack_ts, `${label}: ${notice.title}`, decidedBlocks(approvalBlocks(notice), decision, by));
  return true;
}
