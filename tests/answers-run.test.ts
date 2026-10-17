import { describe, expect, it } from "vitest";
import { answerEngines, type AnswerEngineConfig } from "@/lib/answers/engines";
import { AnswerProbeError } from "@/lib/answers/openrouter-probe";
import { ANSWER_PROBE_RETRIES, type PanelQuestion, type SampleInput, type SampleResult } from "@/lib/answers/sample";
import type { SiteOwnership } from "@/lib/demand/store";
import { sampleSitePanel, type AnswersRunDeps } from "@/lib/inngest/answers";
import { BudgetExceededError } from "@/lib/ops/spend";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const own: SiteOwnership = { siteId: SITE, orgId: ORG, domains: ["acme.com"], pathPrefix: "/resources" };
const engines = answerEngines({}).filter((e) => e.engine === "chatgpt" || e.engine === "perplexity") as AnswerEngineConfig[];
const panel: PanelQuestion[] = [
  { id: "q1", text: "best sso for startups", locale: "us-en", device: "desktop" },
  { id: "q2", text: "okta alternatives", locale: "us-en", device: "desktop" },
];
const run = (attempt = 0) => ({ siteId: SITE, orgId: ORG, attempt, runId: "run-1" });

/**
 * A stand-in for Inngest's `step`: `run` executes the callback and round-trips
 * its result through JSON, as memoisation does; a callback that throws fails
 * the run, for Inngest to retry it. `sendEvent` records what was sent. Pass
 * the `memo` of an earlier attempt to replay its completed steps, as Inngest
 * does when it retries a run.
 */
function fakeStep(memo = new Map<string, unknown>()) {
  const log: string[] = [];
  const sent: { name: string; data: Record<string, unknown> }[] = [];
  const step = {
    async run(id: string, fn: () => unknown) {
      log.push(id);
      if (memo.has(id)) return memo.get(id);
      const v = await fn();
      const out = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
      memo.set(id, out);
      return out;
    },
    async sendEvent(id: string, payload: { name: string; data: Record<string, unknown> }) {
      log.push(id);
      sent.push(payload);
      return { ids: ["evt"] };
    },
  };
  return { step: step as unknown as Parameters<typeof sampleSitePanel>[0], log, sent, memo };
}

const answered = (over: Partial<SampleResult> = {}): SampleResult => ({
  snapshotId: "snap",
  duplicate: false,
  citations: 0,
  ownedCitations: 0,
  mentions: 0,
  brandMentioned: false,
  brandRecommended: false,
  cached: false,
  costUsd: 0.25,
  ...over,
});

/** Deps whose sample answers from `outcome` (an Error is thrown); `asked` lists each sample as question:engine:index. */
function fakeDeps(outcome: (input: SampleInput) => SampleResult | Error = () => answered(), over: Partial<AnswersRunDeps> = {}) {
  const asked: string[] = [];
  const runIds = new Set<string | null>();
  const days = new Set<string>();
  const deps: AnswersRunDeps = {
    loadSite: async () => ({ own, enabled: true }),
    loadPlan: async () => ({ engines, samples: 2, panel, day: "2026-10-13" }),
    async sample(input) {
      asked.push(`${input.question.id}:${input.engine.engine}:${input.sampleIndex}`);
      runIds.add(input.runId);
      days.add(input.day);
      const r = outcome(input);
      if (r instanceof Error) throw r;
      return r;
    },
    ...over,
  };
  return { deps, asked, runIds, days };
}

describe("answers-sample", () => {
  it("runs one step per prompt × engine × sample, named by them, and sends the summary", async () => {
    const { step, log, sent } = fakeStep();
    const { deps, runIds, days } = fakeDeps((i) => (i.engine.engine === "perplexity" && i.sampleIndex === 1 ? answered({ cached: true, costUsd: 0 }) : answered()));
    const summary = await sampleSitePanel(step, run(), deps);
    expect(log).toEqual([
      "load-site",
      "load-plan",
      "probe:q1:chatgpt:0",
      "probe:q1:chatgpt:1",
      "probe:q1:perplexity:0",
      "probe:q1:perplexity:1",
      "probe:q2:chatgpt:0",
      "probe:q2:chatgpt:1",
      "probe:q2:perplexity:0",
      "probe:q2:perplexity:1",
      "notify",
    ]);
    expect([...runIds]).toEqual(["run-1"]);
    // Every step caches under the day the plan was made.
    expect([...days]).toEqual(["2026-10-13"]);
    expect(summary).toEqual({ siteId: SITE, orgId: ORG, probes: 8, cached: 2, failed: 0, costUsd: 1.5, budgetStopped: false });
    expect(sent.map((e) => [e.name, e.data])).toEqual([["answers/sample.completed", summary]]);
  });

  it("stops where it is when the budget is spent, and says so", async () => {
    const { step, log } = fakeStep();
    const { deps, asked } = fakeDeps((i) => (i.question.id === "q1" && i.engine.engine === "perplexity" ? new BudgetExceededError("answer_probe", ORG, 25, 25) : answered()));
    const summary = await sampleSitePanel(step, run(), deps);
    expect(asked).toEqual(["q1:chatgpt:0", "q1:chatgpt:1", "q1:perplexity:0"]);
    expect(log.at(-2)).toBe("probe:q1:perplexity:0");
    expect(log.at(-1)).toBe("notify");
    expect(summary).toMatchObject({ probes: 2, failed: 0, costUsd: 0.5, budgetStopped: true });
  });

  it("skips a sample the engine refused, or one it will answer with nothing again, and goes on", async () => {
    const { step } = fakeStep();
    const { deps, asked } = fakeDeps((i) => {
      if (i.question.id === "q1" && i.engine.engine === "chatgpt" && i.sampleIndex === 0) return new AnswerProbeError("chatgpt", 404, "no such model");
      if (i.question.id === "q2" && i.engine.engine === "perplexity" && i.sampleIndex === 1) return new AnswerProbeError("perplexity", null, "no answer before max_tokens", true);
      return answered();
    });
    const summary = await sampleSitePanel(step, run(), deps);
    expect(asked).toHaveLength(8);
    expect(summary).toMatchObject({ probes: 6, failed: 2, budgetStopped: false });
  });

  it("fails the run on a blip for Inngest to retry, and skips the sample on the last attempt", async () => {
    const busy = (i: SampleInput) => (i.question.id === "q1" && i.engine.engine === "perplexity" && i.sampleIndex === 0 ? new AnswerProbeError("perplexity", 503, "busy") : answered());
    const first = fakeStep();
    await expect(sampleSitePanel(first.step, run(0), fakeDeps(busy).deps)).rejects.toThrow(/busy/);
    expect(first.log.at(-1)).toBe("probe:q1:perplexity:0");
    expect(first.log).not.toContain("notify");

    const last = fakeStep();
    const summary = await sampleSitePanel(last.step, run(ANSWER_PROBE_RETRIES), fakeDeps(busy).deps);
    expect(summary).toMatchObject({ probes: 7, failed: 1 });
    expect(last.log.at(-1)).toBe("notify");
  });

  it("a run retried after midnight keeps the day it started with: its steps find what they paid for", async () => {
    let today = "2026-10-13";
    const busy = (i: SampleInput) => (today === "2026-10-13" && i.question.id === "q2" ? new AnswerProbeError("perplexity", 503, "busy") : answered());
    const { deps, days } = fakeDeps(busy, { loadPlan: async () => ({ engines, samples: 1, panel, day: today }) });
    const first = fakeStep();
    await expect(sampleSitePanel(first.step, run(0), deps)).rejects.toThrow(/busy/);
    today = "2026-10-14";
    const retry = fakeStep(first.memo);
    expect(await sampleSitePanel(retry.step, run(1), deps)).toMatchObject({ probes: 4, failed: 0 });
    expect([...days]).toEqual(["2026-10-13"]);
  });

  it("does nothing for a site that is not the org's, or once staff turned probes off", async () => {
    const elsewhere = fakeStep();
    const notOurs = fakeDeps(undefined, { loadSite: async () => ({ own: { ...own, orgId: "22222222-2222-2222-2222-222222222222" }, enabled: true }) });
    expect(await sampleSitePanel(elsewhere.step, run(), notOurs.deps)).toEqual({ skipped: "site not found" });
    const gone = fakeDeps(undefined, { loadSite: async () => ({ own: null, enabled: true }) });
    expect(await sampleSitePanel(fakeStep().step, run(), gone.deps)).toEqual({ skipped: "site not found" });
    const off = fakeStep();
    const switchedOff = fakeDeps(undefined, { loadSite: async () => ({ own, enabled: false }) });
    expect(await sampleSitePanel(off.step, run(), switchedOff.deps)).toEqual({ skipped: "answer probes are off for this organisation" });
    for (const s of [elsewhere, off]) expect(s.log).toEqual(["load-site"]);
    expect([...notOurs.asked, ...gone.asked, ...switchedOff.asked]).toEqual([]);
  });
});
