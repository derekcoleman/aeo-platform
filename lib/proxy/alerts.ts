import type postgres from "postgres";
import { listConnections, type ConnectorContext } from "@/lib/connectors";
import { escapeMrkdwn, postMessage, slackClientFor, slackTokenFor, type SlackConfig } from "@/lib/connectors/slack";
import { appDb } from "@/lib/db/app";
import { emailConfigured, sendEmail, textToHtml } from "@/lib/notify/email";
import type { HealthResult } from "./health";

/**
 * Site-health alerts. Slack when the org has opted a channel in
 * (`config.alertsChannel`, like approvals); the in-app banner reads
 * `sites.last_health_ok` directly. Email is a later slice. Alerts fire on
 * transitions only — the second consecutive failure, and the recovery —
 * never on every 5-minute tick.
 */

export interface HealthNotice {
  site: { id: string; name: string; canonicalDomain: string; pathPrefix: string };
  ok: boolean;
  failures: number;
  result: HealthResult;
  appUrl?: string;
}

/** The org's active Slack connection that opted into health alerts, if any. */
export async function alertsSlackTarget(orgId: string, sql: postgres.Sql = appDb()) {
  const conns = await listConnections({ orgId, provider: "slack", activeOnly: true }, sql);
  for (const c of conns) {
    const channel = (c.config as Partial<SlackConfig>).alertsChannel;
    if (channel) return { conn: c, channel };
  }
  return null;
}

export function healthAlertText(n: HealthNotice): string {
  const where = `${n.site.canonicalDomain}${n.site.pathPrefix}`;
  if (n.ok) return `Recovered: ${where} is serving again.`;
  const failed = n.result.checks.filter((c) => !c.ok && c.severity === "fail");
  const lines = failed.slice(0, 6).map((c) => `• ${c.key}${hintOf(c.detail)}`);
  return [`Proxy health failing for ${where} (${n.failures} checks in a row).`, ...lines, "Only the content prefix is affected; the rest of the site is untouched.", n.appUrl ? `Details: ${n.appUrl}/sites/${n.site.id}/health` : ""].filter(Boolean).join("\n");
}

function hintOf(detail: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof detail.status === "number") bits.push(`http ${detail.status}`);
  if (typeof detail.error === "string") bits.push(detail.error.slice(0, 120));
  if (typeof detail.hint === "string") bits.push(detail.hint);
  return bits.length ? ` — ${bits.join("; ")}` : "";
}

export async function notifyHealthSlack(orgId: string, notice: HealthNotice, ctx: ConnectorContext): Promise<{ posted: boolean; channel?: string; ts?: string }> {
  const target = await alertsSlackTarget(orgId, ctx.sql);
  if (!target) return { posted: false };
  const api = slackClientFor(target.conn, await slackTokenFor(target.conn, ctx), ctx);
  const text = healthAlertText(notice);
  const { ts, channel } = await postMessage(api, target.channel, text, [{ type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(text) } }]);
  return { posted: true, channel, ts };
}

/** Owners and admins of the org; the people who can actually fix a broken rewrite. */
export async function alertEmailRecipients(orgId: string, sql: postgres.Sql = appDb()): Promise<string[]> {
  const rows = await sql<{ email: string }[]>`
    select u.email from app.memberships m join app.users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.role in ('owner', 'admin') and u.email <> '' order by u.email`;
  return rows.map((r) => r.email);
}

/** Email alert to owners and admins when RESEND_API_KEY is set; otherwise reports why it was skipped. */
export async function notifyHealthEmail(orgId: string, notice: HealthNotice, sql: postgres.Sql = appDb()): Promise<{ sent: boolean; recipients: number; reason?: string }> {
  if (!emailConfigured()) return { sent: false, recipients: 0, reason: "email not configured" };
  const to = await alertEmailRecipients(orgId, sql);
  if (to.length === 0) return { sent: false, recipients: 0, reason: "no owners or admins with an email" };
  const text = healthAlertText(notice);
  const subject = notice.ok ? `Recovered: ${notice.site.canonicalDomain}${notice.site.pathPrefix}` : `Proxy health failing: ${notice.site.canonicalDomain}${notice.site.pathPrefix}`;
  const result = await sendEmail({ to, subject, text, html: textToHtml(text) });
  return { sent: result.sent, recipients: to.length, reason: result.reason };
}
