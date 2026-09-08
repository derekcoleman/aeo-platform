import { emailConfigured, escapeHtmlText, sendEmail } from "@/lib/notify/email";
import { AuditError, runAudit, scoreRating } from "./index";
import { completeAuditRun, markAuditFailed, markAuditRunning, publicAuditContactForRun } from "./store";

export interface AuditJobInput {
  auditRunId: string;
  targetUrl: string;
  kind: "public" | "preflight" | "monitored";
  contentPrefix?: string | null;
}

export type AuditJobSummary =
  | { ok: true; domain: string; geoScore: number; degraded: number }
  | { ok: false; error: string };

/**
 * Run one audit against its row: mark running → crawl and score → persist.
 * Shared by the Inngest function and the in-process fallback the public
 * form uses when no job runner is configured, so both paths write exactly
 * the same rows and a run can never be left in `queued` by either.
 *
 * Unreachable/blocked targets are terminal (the row is marked failed and the
 * summary says so); anything else is rethrown so the caller's retry policy
 * applies. `markAuditFailed` on that path is the caller's job (Inngest's
 * onFailure, or the fallback's catch).
 */
export async function executeAuditRun(input: AuditJobInput): Promise<AuditJobSummary> {
  const { auditRunId, targetUrl, kind, contentPrefix } = input;
  await markAuditRunning(auditRunId);
  try {
    const run = await runAudit(targetUrl, {
      maxPages: kind === "public" ? 12 : 24,
      contentPrefix: contentPrefix ?? undefined,
    });
    await completeAuditRun(auditRunId, run);
    if (kind === "public") await emailReportLink(auditRunId, run.result.domain, run.result.geoScore).catch((e) => console.error(`[audit] report email failed: ${e instanceof Error ? e.message : String(e)}`));
    return { ok: true, domain: run.result.domain, geoScore: run.result.geoScore, degraded: run.result.degraded.length };
  } catch (e) {
    if (e instanceof AuditError) {
      await markAuditFailed(auditRunId, `${e.code}: ${e.message}`);
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

/**
 * The form offers "we'll send you the report link". Keep that promise when
 * Resend and APP_URL are configured; otherwise it is a silent no-op (the
 * report is still on screen for the person who ran it).
 */
export async function emailReportLink(auditRunId: string, domain: string, geoScore: number, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!emailConfigured(env) || !env.APP_URL) return false;
  const contact = await publicAuditContactForRun(auditRunId);
  if (!contact?.email) return false;
  const url = `${env.APP_URL.replace(/\/$/, "")}/audit/${contact.slug}`;
  const text = `${domain} scores ${geoScore}/100 (${scoreRating(geoScore)}) for AI answers.\n\nYour report: ${url}\n\nThe link works for 30 days.`;
  const html = `<p><strong>${escapeHtmlText(domain)}</strong> scores <strong>${geoScore}/100</strong> (${scoreRating(geoScore)}) for AI answers.</p><p><a href="${url}">Open your report</a></p><p style="color:#666">The link works for 30 days.</p>`;
  const res = await sendEmail({ to: [contact.email], subject: `${domain}: ${geoScore}/100 for AI answers`, text, html }, env);
  return res.sent;
}

/** Minutes a run may sit in `queued` (never picked up) or `running` (runner died) before the poller reports it failed. */
export const QUEUED_STALE_MINUTES = 5;
export const RUNNING_STALE_MINUTES = 15;

export const STALE_QUEUED_MESSAGE = "The audit was never picked up by the job runner. Check that Inngest is connected (or that the app can run audits inline) and try again.";
export const STALE_RUNNING_MESSAGE = "The audit stopped before it finished. Please try again.";

/**
 * Decide whether a run that still reports queued/running has actually been
 * abandoned. Pure so the rule is unit-tested; the poll route applies it.
 */
export function staleAuditError(run: { status: string; created_at: string | Date; started_at: string | Date | null }, now: Date = new Date()): string | null {
  const ms = (d: string | Date | null) => (d ? now.getTime() - new Date(d).getTime() : 0);
  if (run.status === "queued" && ms(run.created_at) > QUEUED_STALE_MINUTES * 60_000) return STALE_QUEUED_MESSAGE;
  if (run.status === "running" && ms(run.started_at ?? run.created_at) > RUNNING_STALE_MINUTES * 60_000) return STALE_RUNNING_MESSAGE;
  return null;
}
