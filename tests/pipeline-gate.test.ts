import { describe, expect, it } from "vitest";
import type { ApprovalNotice, ApprovalRow, DecisionInput } from "@/lib/pipeline/approvals";
import { applyDecision, approvalUrl, GATE_MAX_WAITS, GATE_WINDOW, GATE_WINDOWS, gateMatchExpression, humanGate, type DecisionDeps, type GateDeps, type GateStep } from "@/lib/pipeline/gate";
import { ORG_ID, SITE_ID } from "./fixtures/pipeline";

const APPROVAL_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const T0 = new Date("2026-09-01T09:00:00.000Z");
const DAY = 86_400_000;

interface DecidedEvent {
  name: "approval/decided";
  data: { approvalId: string; decision: "approve" | "changes" | "regenerate"; by: { userId?: string | null; name?: string | null }; source: "slack" | "app" | "ops"; note?: string | null; orgId?: string | null };
}

const decidedEvent = (data: Partial<DecidedEvent["data"]> = {}): DecidedEvent => ({
  name: "approval/decided",
  data: { approvalId: APPROVAL_ID, decision: "approve", by: { userId: "u1", name: "Dana" }, source: "app", note: null, orgId: ORG_ID, ...data },
});

/**
 * A stand-in for Inngest's `step`: `run` executes the callback and round-trips
 * its result through JSON (as memoisation does, so Dates arrive as strings),
 * `waitForEvent` answers from a script (null = the window timed out). With a
 * clock, a timed-out wait advances it by the window, an answered one by a
 * minute, and `sleepUntil` moves it to the wake time.
 */
function fakeStep(script: (DecidedEvent | null)[], clock?: { t: number }) {
  const log: string[] = [];
  const waits: { id: string; opts: { event: { name: string }; if: string; timeout: string } }[] = [];
  const sent: { id: string; payload: { name: string; data: Record<string, unknown> } }[] = [];
  const sleeps: { id: string; until: Date }[] = [];
  const step = {
    async run(id: string, fn: () => unknown) {
      log.push(id);
      const v = await fn();
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    async sendEvent(id: string, payload: { name: string; data: Record<string, unknown> }) {
      log.push(id);
      sent.push({ id, payload });
      return { ids: ["evt"] };
    },
    async waitForEvent(id: string, opts: { event: { name: string }; if: string; timeout: string }) {
      log.push(id);
      waits.push({ id, opts });
      const evt = script.shift() ?? null;
      if (clock) clock.t += evt ? 60_000 : 6 * 3_600_000;
      return evt;
    },
    async sleepUntil(id: string, until: Date) {
      log.push(id);
      sleeps.push({ id, until });
      if (clock) clock.t = Math.max(clock.t, until.getTime());
    },
  };
  return { step: step as unknown as GateStep, log, waits, sent, sleeps };
}

/** Deps over one in-memory approval row. `onLoad` lets a test change the row (or the clock) as time passes. */
function fakeDeps(row: Partial<ApprovalRow> = {}, opts: { now?: () => Date; notifyFails?: boolean; onLoad?: (r: ApprovalRow, loads: number) => void } = {}) {
  const state: { row: ApprovalRow | null; loads: number; expired: number; notices: ApprovalNotice[] } = {
    row: null,
    loads: 0,
    expired: 0,
    notices: [],
  };
  const deps: GateDeps = {
    async createApproval(input) {
      state.row = {
        id: APPROVAL_ID,
        org_id: ORG_ID,
        site_id: input.siteId,
        kind: input.kind,
        brief_id: input.briefId ?? null,
        content_version_id: input.contentVersionId ?? null,
        status: "pending",
        slack_channel: null,
        slack_ts: null,
        expires_at: input.expiresAt ?? null,
        note: null,
        decided_by: null,
        ...row,
      };
      return { id: APPROVAL_ID };
    },
    async loadApproval() {
      state.loads++;
      if (state.row) opts.onLoad?.(state.row, state.loads);
      return state.row;
    },
    async expireApproval() {
      state.expired++;
      if (state.row?.status !== "pending") return { applied: false };
      state.row.status = "expired";
      return { applied: true };
    },
    async notifyApprovalSlack(_orgId, notice) {
      state.notices.push(notice);
      if (opts.notifyFails) throw new Error("slack down");
    },
    appUrl: "https://app.test",
    now: opts.now ?? (() => T0),
  };
  return { deps, state };
}

const input = { kind: "brief" as const, siteId: SITE_ID, orgId: ORG_ID, briefId: "brief-1", notice: { kind: "brief" as const, title: "SSO vs SCIM", summary: "Two halves of identity." } };

describe("gateMatchExpression", () => {
  it("matches on the awaited event (`async`), not the run's trigger (`event`)", () => {
    expect(gateMatchExpression(APPROVAL_ID)).toBe(`async.data.approvalId == "${APPROVAL_ID}"`);
    expect(gateMatchExpression(APPROVAL_ID)).not.toContain("event.data");
  });
});

describe("humanGate", () => {
  it("opens the approval with a 7-day expiry, links the app's approval page, and resumes on the decision event", async () => {
    const { step, log, waits, sent } = fakeStep([decidedEvent({ decision: "changes", note: "Lead with offboarding." })]);
    const { deps, state } = fakeDeps();
    const result = await humanGate(step, "brief-gate:1", input, deps);

    expect(result).toEqual({ decision: "changes", note: "Lead with offboarding.", by: "Dana" });
    expect(log).toEqual(["brief-gate:1:open", "brief-gate:1:requested", "brief-gate:1:wait:0"]);
    expect(waits[0]!.opts).toMatchObject({ event: { name: "approval/decided" }, if: gateMatchExpression(APPROVAL_ID), timeout: GATE_WINDOW });
    expect(state.row!.expires_at!.getTime() - T0.getTime()).toBe(7 * DAY);
    expect(state.notices[0]!.previewUrl).toBe(`https://app.test/app/approvals/${APPROVAL_ID}`);
    expect(approvalUrl("https://app.test", APPROVAL_ID)).toBe(state.notices[0]!.previewUrl);
    expect(sent[0]!.payload).toMatchObject({ name: "approval/requested", data: { approvalId: APPROVAL_ID, kind: "brief", siteId: SITE_ID, orgId: ORG_ID } });
  });

  it("resumes from the stored decision when the event was missed (a click before the wait existed)", async () => {
    const { step, log } = fakeStep([null]);
    const { deps } = fakeDeps({ status: "approve", note: "ship it", decided_by: { userId: "u1", name: "Dana" } });
    expect(await humanGate(step, "draft-gate:1", { ...input, kind: "draft" }, deps)).toEqual({ decision: "approve", note: "ship it", by: "Dana" });
    expect(log).toEqual(["draft-gate:1:open", "draft-gate:1:requested", "draft-gate:1:wait:0", "draft-gate:1:check:0"]);
  });

  it("keeps waiting window after window while the approval is pending", async () => {
    // Pending for two windows, decided (by the Slack path) before the third check.
    const { step, log } = fakeStep([null, null, null]);
    const { deps } = fakeDeps({}, { onLoad: (r, loads) => loads === 3 && Object.assign(r, { status: "regenerate", decided_by: { userId: "U9", name: null } }) });
    expect(await humanGate(step, "g", input, deps)).toEqual({ decision: "regenerate", note: null, by: "U9" });
    expect(log.filter((l) => l.startsWith("g:wait:"))).toEqual(["g:wait:0", "g:wait:1", "g:wait:2"]);
  });

  it("expires the approval and returns null when every window passes in silence", async () => {
    const clock = { t: T0.getTime() };
    const { step, log, sleeps } = fakeStep([], clock);
    const { deps, state } = fakeDeps({}, { now: () => new Date(clock.t) });
    expect(await humanGate(step, "g", input, deps)).toBeNull();
    expect(GATE_WINDOWS).toBe(28);
    expect(log.filter((l) => l.startsWith("g:wait:"))).toHaveLength(GATE_WINDOWS);
    expect(log.filter((l) => l.startsWith("g:check:"))).toHaveLength(GATE_WINDOWS);
    expect(sleeps).toEqual([]);
    expect(log.at(-1)).toBe("g:expire");
    expect(state.expired).toBe(1);
    expect(state.row!.status).toBe("expired");
  });

  it("does not let ignored events run the gate out early: it holds until the expiry, then expires", async () => {
    // Every wait is cut short a minute in by a Slack click from another org's workspace.
    const clock = { t: T0.getTime() };
    const foreign = Array.from({ length: GATE_MAX_WAITS }, () => decidedEvent({ source: "slack", orgId: OTHER_ORG }));
    const { step, log, sleeps } = fakeStep(foreign, clock);
    let expiredAt = 0;
    const { deps, state } = fakeDeps({}, { now: () => new Date(clock.t) });
    const expire = deps.expireApproval;
    deps.expireApproval = (id) => ((expiredAt = clock.t), expire(id));

    expect(await humanGate(step, "g", input, deps)).toBeNull();
    expect(log.filter((l) => l.startsWith("g:wait:"))).toHaveLength(GATE_MAX_WAITS);
    expect(sleeps).toEqual([{ id: "g:hold", until: state.row!.expires_at }]);
    expect(expiredAt).toBe(T0.getTime() + 7 * DAY);
    expect(log.slice(-2)).toEqual(["g:hold", "g:expire"]);
    // The worst case, five gates per run, stays far inside Inngest's 1000-step limit.
    expect(log.length).toBe(2 + 2 * GATE_MAX_WAITS + 2);
    expect(log.length * 5).toBeLessThan(700);
  });

  it("honours a decision recorded while the gate holds out the expiry", async () => {
    const clock = { t: T0.getTime() };
    const foreign = Array.from({ length: GATE_MAX_WAITS }, () => decidedEvent({ source: "slack", orgId: OTHER_ORG }));
    const { step } = fakeStep(foreign, clock);
    const { deps, state } = fakeDeps({}, { now: () => new Date(clock.t) });
    const expire = deps.expireApproval;
    deps.expireApproval = (id) => {
      // A click through the app landed during the hold; the expiry finds nothing pending.
      Object.assign(state.row!, { status: "approve", decided_by: { name: "Dana" } });
      return expire(id);
    };
    expect(await humanGate(step, "g", input, deps)).toEqual({ decision: "approve", note: null, by: "Dana" });
    expect(state.row!.status).toBe("approve");
  });

  it("stops at the stored expiry instead of running out the windows", async () => {
    let clock = T0.getTime();
    const { step, log } = fakeStep([null, null]);
    const { deps, state } = fakeDeps({}, { now: () => new Date(clock), onLoad: () => (clock += 8 * DAY) });
    expect(await humanGate(step, "g", input, deps)).toBeNull();
    expect(log).toEqual(["g:open", "g:requested", "g:wait:0", "g:check:0", "g:expire"]);
    expect(state.expired).toBe(1);
  });

  it("returns null for an approval that was already expired elsewhere", async () => {
    const { step } = fakeStep([null]);
    const { deps, state } = fakeDeps({ status: "expired" });
    expect(await humanGate(step, "g", input, deps)).toBeNull();
    expect(state.row!.status).toBe("expired");
  });

  it("lets a decision that lands between the last check and the expiry win", async () => {
    let clock = T0.getTime();
    const { step } = fakeStep([null]);
    const { deps, state } = fakeDeps({}, { now: () => new Date(clock), onLoad: () => (clock += 8 * DAY) });
    // The check sees pending-but-lapsed; a click is recorded just before expire runs.
    deps.expireApproval = async () => {
      Object.assign(state.row!, { status: "approve", decided_by: { name: "Dana" } });
      return { applied: false };
    };
    expect(await humanGate(step, "g", input, deps)).toEqual({ decision: "approve", note: null, by: "Dana" });
  });

  it("ignores a Slack decision from another org's workspace and keeps waiting", async () => {
    const { step, log } = fakeStep([decidedEvent({ source: "slack", orgId: OTHER_ORG }), decidedEvent({ source: "slack", orgId: null }), decidedEvent({ source: "slack", by: { userId: "U1", name: null } })]);
    const { deps } = fakeDeps();
    expect(await humanGate(step, "g", input, deps)).toEqual({ decision: "approve", note: null, by: "U1" });
    expect(log.filter((l) => l.startsWith("g:wait:"))).toEqual(["g:wait:0", "g:wait:1", "g:wait:2"]);
  });

  it("opens the gate even when the Slack notice fails", async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const { step } = fakeStep([decidedEvent()]);
      const { deps } = fakeDeps({}, { notifyFails: true });
      expect(await humanGate(step, "g", input, deps)).toMatchObject({ decision: "approve" });
    } finally {
      console.warn = warn;
    }
  });
});

describe("applyDecision (approval-decided)", () => {
  const posted: ApprovalRow = {
    id: APPROVAL_ID,
    org_id: ORG_ID,
    site_id: SITE_ID,
    kind: "brief",
    brief_id: "brief-1",
    content_version_id: null,
    status: "pending",
    slack_channel: "C1",
    slack_ts: "1700000000.000100",
    expires_at: null,
    note: null,
    decided_by: null,
  };

  /** Deps over one approval row: `record` applies only to a pending row (and only for the expected org), as recordDecision does. */
  function decisionDeps(row: ApprovalRow = posted) {
    const state = { row: { ...row }, records: [] as DecisionInput[], slackUpdates: [] as { decision: string; by: string }[] };
    const deps: DecisionDeps = {
      async recordDecision(_id, input) {
        state.records.push(input);
        if (state.row.status !== "pending" || (input.expectOrgId && input.expectOrgId !== state.row.org_id)) return { applied: false };
        state.row = { ...state.row, status: input.decision, decided_by: input.by, note: input.note ?? null };
        return { applied: true };
      },
      async loadApproval() {
        return state.row;
      },
      async noticeFor(a) {
        return { approvalId: a.id, kind: a.kind, title: "SSO vs SCIM", summary: "s", previewUrl: approvalUrl("https://app.test", a.id) };
      },
      async updateSlackDecision(_a, decision, by) {
        state.slackUpdates.push({ decision, by });
        return true;
      },
    };
    return { deps, state };
  }

  it("ignores a Slack decision that names no org: nothing is recorded, nothing is rewritten", async () => {
    const { step, log } = fakeStep([]);
    const { deps, state } = decisionDeps();
    expect(await applyDecision(step, decidedEvent({ source: "slack", orgId: null }).data, deps)).toEqual({ applied: false, ignored: "slack decision without an org" });
    expect(log).toEqual([]);
    expect(state.records).toEqual([]);
    expect(state.slackUpdates).toEqual([]);
  });

  it("records a Slack decision only for the org of the workspace that sent it", async () => {
    const { step } = fakeStep([]);
    const { deps, state } = decisionDeps();
    expect(await applyDecision(step, decidedEvent({ source: "slack", orgId: ORG_ID }).data, deps)).toEqual({ applied: true, slackUpdated: true });
    expect(state.records[0]).toMatchObject({ decision: "approve", source: "slack", expectOrgId: ORG_ID });

    const other = decisionDeps();
    expect(await applyDecision(fakeStep([]).step, decidedEvent({ source: "slack", orgId: OTHER_ORG }).data, other.deps)).toEqual({ applied: false, slackUpdated: false });
    expect(other.state.records[0]!.expectOrgId).toBe(OTHER_ORG);
    expect(other.state.row.status).toBe("pending");
  });

  it("checks no org for app and ops decisions (their server actions did)", async () => {
    const { deps, state } = decisionDeps();
    await applyDecision(fakeStep([]).step, decidedEvent({ source: "app", orgId: OTHER_ORG }).data, deps);
    expect(state.records[0]!.expectOrgId).toBeNull();
  });

  it("rewrites the Slack message after an app decision the app already recorded", async () => {
    const { step, log } = fakeStep([]);
    const { deps, state } = decisionDeps({ ...posted, status: "approve", decided_by: { userId: "u1", name: "Dana" } });
    expect(await applyDecision(step, decidedEvent({ source: "app" }).data, deps)).toEqual({ applied: false, slackUpdated: true });
    expect(log).toEqual(["record", "update-slack"]);
    expect(state.slackUpdates).toEqual([{ decision: "approve", by: "Dana" }]);
  });

  it("leaves the Slack message alone when the stored decision is someone else's", async () => {
    const { deps, state } = decisionDeps({ ...posted, status: "approve", decided_by: { userId: "u2", name: "Lee" } });
    expect(await applyDecision(fakeStep([]).step, decidedEvent({ source: "app" }).data, deps)).toEqual({ applied: false, slackUpdated: false });
    expect(state.slackUpdates).toEqual([]);
  });

  it("does not touch Slack when nothing was posted there", async () => {
    const { deps, state } = decisionDeps({ ...posted, slack_ts: null });
    expect(await applyDecision(fakeStep([]).step, decidedEvent().data, deps)).toEqual({ applied: true, slackUpdated: false });
    expect(state.slackUpdates).toEqual([]);
  });
});
