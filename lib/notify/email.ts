/**
 * Transactional email through Resend's REST API. No SDK: one POST, one
 * key. When RESEND_API_KEY is unset every send is a no-op that says so,
 * which is what lets alerts and invites degrade honestly rather than throw.
 */

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface EmailResult {
  sent: boolean;
  id?: string;
  reason?: string;
}

export interface EmailEnv {
  [key: string]: string | undefined;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_FROM?: string;
}

export function emailConfigured(env: EmailEnv = process.env): boolean {
  return !!env.RESEND_API_KEY && !!env.ALERT_EMAIL_FROM;
}

export async function sendEmail(msg: EmailMessage, env: EmailEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<EmailResult> {
  if (!emailConfigured(env)) return { sent: false, reason: "RESEND_API_KEY / ALERT_EMAIL_FROM not set" };
  const to = msg.to.map((t) => t.trim()).filter(Boolean).slice(0, 50);
  if (to.length === 0) return { sent: false, reason: "no recipients" };
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_EMAIL_FROM, to, subject: msg.subject.slice(0, 200), text: msg.text, html: msg.html, reply_to: msg.replyTo }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { sent: false, reason: `resend status ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { sent: true, id: body.id };
}

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text in, a minimal readable HTML body out. Nothing clever; alerts must render everywhere. */
export function textToHtml(text: string): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${escapeHtmlText(text)}</div>`;
}
