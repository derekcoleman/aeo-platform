import { approvalDecided, approvalRequested, type inngest } from "@/lib/inngest/client";
import { holdsDecision, type ApprovalKind, type ApprovalNotice, type ApprovalRow, type DecisionInput } from "./approvals";
import type { ApprovalDecision } from "./types";

/**
 * The human gate inside the content pipeline: open an approval, tell Slack
 * (best effort) and the app, then hold the run until a person decides or the
 * approval lapses.
 *
 * The hold is a series of 6-hour `waitForEvent` windows rather than one
 * 7-day wait. After each quiet window the gate re-reads the approval row, so
 * a decision whose event the wait never saw still resumes the run: a click
 * that landed before the wait was registered, or a Slack decision recorded
 * by `approval-decided`. Inngest evaluates the match with `async` bound to the
 * awaited event (`event` is the run's trigger), so the expression must read
 * `async.data`.
 *
 * The hold ends at `expires_at`, never at a count of windows: an event the
 * gate ignores (a Slack click from another org's workspace) ends a window
 * early, so the number of waits is only a cap on the step budget, and a gate
 * that reaches it sleeps out the rest of the TTL before it expires.
 *
 * Step ids are durable state. A run paused when they change keeps the wait
 * it registered under the old id until that wait times out: runs paused at a
 * gate under the pre-fix `${label}:wait` id stay there for up to its 7 days,
 * then replay into this loop and pick up a stored decision one window later.
 * To resume them sooner, cancel them in Inngest and re-queue their
 * opportunities.
 */

export const GATE_TTL_DAYS = 7;
const GATE_TTL_MS = GATE_TTL_DAYS * 86_400_000;
export const GATE_WINDOW = "6h";
const GATE_WINDOW_MS = 6 * 3_600_000;
/** 28 six-hour windows cover the 7-day TTL. */
export const GATE_WINDOWS = Math.ceil(GATE_TTL_MS / GATE_WINDOW_MS);
/**
 * Waits per gate before it stops waiting for events and sleeps out the TTL.
 * Each wait costs two steps; five gates at this cap stay well inside
 * Inngest's 1000-step run limit.
 */
export const GATE_MAX_WAITS = 2 * GATE_WINDOWS;

export type GateStep = Parameters<Parameters<typeof inngest.createFunction>[1]>[0]["step"];

export interface GateResult {
  decision: ApprovalDecision;
  note: string | null;
  by: string;
}

export interface GateInput {
  kind: ApprovalKind;
  siteId: string;
  orgId: string;
  briefId?: string | null;
  contentVersionId?: string | null;
  /** The preview link is the approval page, built once the approval has an id. */
  notice: Omit<ApprovalNotice, "approvalId" | "previewUrl">;
}

export interface GateDeps {
  createApproval(input: { siteId: string; kind: ApprovalKind; briefId?: string | null; contentVersionId?: string | null; expiresAt?: Date | null }): Promise<{ id: string }>;
  loadApproval(id: string): Promise<ApprovalRow | null>;
  expireApproval(id: string): Promise<{ applied: boolean }>;
  notifyApprovalSlack(orgId: string, notice: ApprovalNotice): Promise<unknown>;
  /** The app's base URL, no trailing slash. */
  appUrl: string;
  now?: () => Date;
}

/** Match the decision for this approval. `async` is the incoming approval/decided event. */
export function gateMatchExpression(approvalId: string): string {
  return `async.data.approvalId == "${approvalId}"`;
}

/** Where a reviewer decides: the app's approval page (Slack buttons are a shortcut to the same decision). */
export function approvalUrl(appUrl: string, approvalId: string): string {
  return `${appUrl}/app/approvals/${approvalId}`;
}

type DecidedData = { decision: ApprovalDecision; note?: string | null; by: { userId?: string | null; name?: string | null }; source: "slack" | "app" | "ops"; orgId?: string | null };

/**
 * A Slack click carries the org of the workspace it came from; only that
 * org's own approvals resume. App and ops decisions were permission-checked
 * by the server action that sent them.
 */
function trusted(data: DecidedData, orgId: string): boolean {
  return data.source !== "slack" || data.orgId === orgId;
}

/** The decision stored on the row, if there is one. Expired or pending is no decision. */
function decided(row: ApprovalRow | null): GateResult | null {
  if (!row || row.status === "pending" || row.status === "expired") return null;
  return { decision: row.status, note: row.note ?? null, by: row.decided_by?.name ?? row.decided_by?.userId ?? "unknown" };
}

export async function humanGate(step: GateStep, label: string, input: GateInput, deps: GateDeps): Promise<GateResult | null> {
  const now = deps.now ?? (() => new Date());
  const approvalId = await step.run(`${label}:open`, async () => {
    const { id } = await deps.createApproval({
      siteId: input.siteId,
      kind: input.kind,
      briefId: input.briefId ?? null,
      contentVersionId: input.contentVersionId ?? null,
      expiresAt: new Date(now().getTime() + GATE_TTL_MS),
    });
    try {
      await deps.notifyApprovalSlack(input.orgId, { ...input.notice, approvalId: id, previewUrl: approvalUrl(deps.appUrl, id) });
    } catch (e) {
      // Slack is a convenience path; the app UI always renders the gate.
      console.warn(`[pipeline] slack approval notice failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return id;
  });
  await step.sendEvent(`${label}:requested`, approvalRequested.create({ approvalId, kind: input.kind, siteId: input.siteId, orgId: input.orgId }));

  let pendingUntil: string | null = null;
  for (let w = 0; w < GATE_MAX_WAITS; w++) {
    const evt = await step.waitForEvent(`${label}:wait:${w}`, { event: approvalDecided, if: gateMatchExpression(approvalId), timeout: GATE_WINDOW });
    if (evt && trusted(evt.data, input.orgId)) {
      return { decision: evt.data.decision, note: evt.data.note ?? null, by: evt.data.by.name ?? evt.data.by.userId ?? evt.data.source };
    }
    const state = await step.run(`${label}:check:${w}`, async () => {
      const row = await deps.loadApproval(approvalId);
      const lapsed = row?.expires_at ? new Date(row.expires_at).getTime() <= now().getTime() : false;
      return { status: row?.status ?? null, result: decided(row), lapsed, expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null };
    });
    if (state.result) return state.result;
    if (state.status !== "pending" || state.lapsed) {
      pendingUntil = null;
      break;
    }
    pendingUntil = state.expiresAt;
  }
  // Out of waits with time left (ignored events cut windows short): hold until the expiry itself.
  if (pendingUntil) await step.sleepUntil(`${label}:hold`, new Date(pendingUntil));

  // A decision can still land between the last check and the expiry; it wins.
  return step.run(`${label}:expire`, async () => {
    const { applied } = await deps.expireApproval(approvalId);
    return applied ? null : decided(await deps.loadApproval(approvalId));
  });
}

// ── approval-decided ───────────────────────────────────────────────────────

export interface DecisionDeps {
  recordDecision(approvalId: string, input: DecisionInput): Promise<{ applied: boolean }>;
  loadApproval(id: string): Promise<ApprovalRow | null>;
  noticeFor(approval: ApprovalRow): Promise<ApprovalNotice | null>;
  updateSlackDecision(approval: ApprovalRow, decision: ApprovalDecision, by: string, notice: ApprovalNotice): Promise<boolean>;
}

/**
 * Record a human decision (from Slack, the app or ops) and rewrite the Slack
 * message so it cannot be clicked twice. A Slack click is recorded only for
 * the org of the workspace it came from, and not at all without one. The app
 * records its decision before sending the event, so for an app decision the
 * record step finds nothing pending; the Slack message is still rewritten
 * when the stored decision is this one, by this person.
 */
export async function applyDecision(step: GateStep, data: DecidedData & { approvalId: string }, deps: DecisionDeps) {
  const { approvalId, decision, by, source, note, orgId = null } = data;
  if (source === "slack" && !orgId) return { applied: false, ignored: "slack decision without an org" };
  const decider = { userId: by.userId ?? null, name: by.name ?? null };
  const recorded = await step.run("record", () =>
    deps.recordDecision(approvalId, { decision, by: decider, source, note: note ?? null, expectOrgId: source === "slack" ? orgId : null }),
  );
  const slackUpdated = await step.run("update-slack", async () => {
    const approval = await deps.loadApproval(approvalId);
    if (!approval?.slack_ts) return false;
    if (!recorded.applied && !holdsDecision(approval, decision, decider)) return false;
    const notice = await deps.noticeFor(approval);
    if (!notice) return false;
    return deps.updateSlackDecision(approval, decision, by.name ?? by.userId ?? source, notice);
  });
  return { applied: recorded.applied, slackUpdated };
}
