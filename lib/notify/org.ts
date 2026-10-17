import { connectorContext, type ConnectorContext } from "@/lib/connectors";
import { escapeMrkdwn, postMessage, slackClientFor, slackTokenFor } from "@/lib/connectors/slack";
import { alertEmailRecipients, alertsSlackTarget } from "@/lib/proxy/alerts";
import { emailConfigured, sendEmail, textToHtml } from "./email";

/**
 * Tell an organisation something happened to its site that it should not
 * learn from a traffic graph: a page taken down, indexing paused, a rollback.
 * Same channels as the health alerts: the Slack channel the org opted into
 * (`config.alertsChannel`), and email to its owners and admins when Resend
 * is configured. Best effort on both: a notification never undoes or blocks
 * the change it reports, so failures come back as `errors`, never thrown.
 */

export interface OrgNotifyResult {
  slack: boolean;
  email: boolean;
  errors: string[];
}

export async function notifyOrg(
  orgId: string,
  text: string,
  opts: { subject?: string; ctx?: ConnectorContext } = {},
): Promise<OrgNotifyResult> {
  const ctx = opts.ctx ?? connectorContext();
  const out: OrgNotifyResult = { slack: false, email: false, errors: [] };
  const subject = (opts.subject ?? text.split("\n")[0] ?? "").slice(0, 200);

  try {
    const target = await alertsSlackTarget(orgId, ctx.sql);
    if (target) {
      const api = slackClientFor(target.conn, await slackTokenFor(target.conn, ctx), ctx);
      await postMessage(api, target.channel, text, [{ type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(text) } }]);
      out.slack = true;
    }
  } catch (e) {
    out.errors.push(`slack: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    if (emailConfigured(ctx.env)) {
      const to = await alertEmailRecipients(orgId, ctx.sql);
      if (to.length) {
        const r = await sendEmail({ to, subject, text, html: textToHtml(text) }, ctx.env, ctx.fetchImpl);
        out.email = r.sent;
        if (!r.sent && r.reason) out.errors.push(`email: ${r.reason}`);
      }
    }
  } catch (e) {
    out.errors.push(`email: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (out.errors.length) console.warn(`[notify] org ${orgId}: ${out.errors.join("; ")}`);
  return out;
}
