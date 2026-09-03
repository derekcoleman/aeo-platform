import type postgres from "postgres";
import { listConnections, type ConnectorContext } from "@/lib/connectors";
import { escapeMrkdwn, postMessage, slackClientFor, slackTokenFor, type SlackConfig } from "@/lib/connectors/slack";
import { appDb } from "@/lib/db/app";
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
