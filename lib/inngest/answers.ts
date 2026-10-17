import { appDb } from "@/lib/db/app";
import { loadSiteOwnership, type SiteOwnership } from "@/lib/demand/store";
import { answerEngines, answerPanelSize, answerSamples, type AnswerEngineConfig } from "@/lib/answers/engines";
import { probeAnswer } from "@/lib/answers/openrouter-probe";
import {
  ANSWER_PROBE_RETRIES,
  ANSWER_PROBES_FEATURE,
  answerProbesConfigured,
  fitPanel,
  loadAnswerPanel,
  probeFailure,
  sampleAnswer,
  sitesForAnswerProbes,
  type PanelQuestion,
  type SampleInput,
  type SampleResult,
} from "@/lib/answers/sample";
import { isFeatureEnabled } from "@/lib/connectors/store";
import { defaultSpendGovernor } from "@/lib/ops/spend";
import type { GateStep } from "@/lib/pipeline/gate";
import { dayOf, postgresCache } from "@/lib/serp/cache";
import { answersSampleCompleted, answersSampleRequested, concurrencyCap, inngest } from "./client";

/**
 * Native answer sampling: each sampled site's prompt panel asked of every
 * enabled answer engine through OpenRouter, weekly. API-grounded probes,
 * recorded as such (lib/answers) and reported apart from Google AI Overview
 * and Profound numbers.
 *
 * A weekly scheduler fans out one event per site whose organisation has the
 * `answer_probes` feature (off by default; staff turn it on per org). The
 * sampler runs one durable step per prompt × engine × sample, so a retry
 * after a blip re-pays only what had not completed; a sample whose probe
 * fails is skipped and the rest go on, and a spent answer_probe budget is a
 * clean stop. One run per org at a time.
 */

export interface AnswersRunDeps {
  /** The site's ownership, and whether its organisation still has answer probes on. */
  loadSite(siteId: string, orgId: string): Promise<{ own: SiteOwnership | null; enabled: boolean }>;
  /**
   * What the run asks: the engines, how many samples each, the panel cut to
   * the run's steps, and the day its answers are cached under (today, kept
   * with the plan: a step retried after midnight finds what it paid for).
   */
  loadPlan(siteId: string): Promise<{ engines: AnswerEngineConfig[]; samples: number; panel: PanelQuestion[]; day: string }>;
  sample(input: SampleInput): Promise<SampleResult>;
}

const liveAnswersDeps: AnswersRunDeps = {
  loadSite: async (siteId, orgId) => ({ own: await loadSiteOwnership(siteId), enabled: await isFeatureEnabled(orgId, ANSWER_PROBES_FEATURE) }),
  loadPlan: async (siteId) => {
    const engines = answerEngines();
    const samples = answerSamples();
    return { engines, samples, panel: fitPanel(await loadAnswerPanel(siteId, answerPanelSize()), engines.length, samples), day: dayOf() };
  },
  sample: (input) => {
    const sql = appDb();
    return sampleAnswer(input, { sql, cache: postgresCache(sql), governor: defaultSpendGovernor(sql), probe: (cfg, prompt) => probeAnswer(cfg, prompt) });
  },
};

/** One site's panel, one step per prompt × engine × sample. `attempt` is the run's (0-based); a failed sample is skipped on the last. */
export async function sampleSitePanel(
  step: Pick<GateStep, "run" | "sendEvent">,
  run: { siteId: string; orgId: string; attempt: number; runId: string },
  deps: AnswersRunDeps = liveAnswersDeps,
) {
  const { siteId, orgId, attempt, runId } = run;
  const site = await step.run("load-site", () => deps.loadSite(siteId, orgId));
  const own = site.own;
  if (!own || own.orgId !== orgId) return { skipped: "site not found" as const };
  // Checked here too, not only by the scheduler: staff may have turned it off since.
  if (!site.enabled) return { skipped: "answer probes are off for this organisation" as const };
  // Read once and memoised: a run keeps the engines and the day it started with. A bad AEO_ANSWER_ENGINES fails here, loudly.
  const plan = await step.run("load-plan", () => deps.loadPlan(siteId));

  let probes = 0;
  let cached = 0;
  let failed = 0;
  let costUsd = 0;
  let budgetStopped = false;
  outer: for (const q of plan.panel) {
    for (const engine of plan.engines) {
      for (let s = 0; s < plan.samples; s++) {
        const r = await step.run(`probe:${q.id}:${engine.engine}:${s}`, async () => {
          try {
            const out = await deps.sample({ own, question: q, engine, sampleIndex: s, runId, day: plan.day });
            return { ok: true as const, cached: out.cached, cost: out.costUsd };
          } catch (e) {
            const next = probeFailure(e, attempt);
            if (next === "budget") return { ok: false as const, budget: true as const };
            if (next === "retry") throw e;
            const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
            console.warn(`[answers] ${engine.engine} probe of question ${q.id} skipped: ${message}`);
            return { ok: false as const, budget: false as const, error: message };
          }
        });
        if (!r.ok) {
          if (r.budget) {
            budgetStopped = true;
            break outer;
          }
          failed += 1;
          continue;
        }
        probes += 1;
        if (r.cached) cached += 1;
        costUsd += r.cost;
      }
    }
  }

  const summary = { siteId, orgId, probes, cached, failed, costUsd, budgetStopped };
  await step.sendEvent("notify", answersSampleCompleted.create(summary));
  return summary;
}

export const answersSampleFunction = inngest.createFunction(
  {
    id: "answers-sample",
    triggers: [answersSampleRequested],
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: concurrencyCap(5) }],
    retries: ANSWER_PROBE_RETRIES,
  },
  async ({ event, step, attempt, runId }) => {
    if (!answerProbesConfigured()) return { skipped: "OPENROUTER_API_KEY is not set" as const };
    return sampleSitePanel(step, { siteId: event.data.siteId, orgId: event.data.orgId, attempt, runId });
  },
);

/** Tuesdays 10:00 UTC: every site whose organisation has answer probes on. */
export const answersSampleWeekly = inngest.createFunction(
  { id: "answers-sample-weekly", triggers: [{ cron: "0 10 * * 2" }], concurrency: [{ limit: concurrencyCap(1) }], retries: 0 },
  async ({ step }) => {
    if (!answerProbesConfigured()) return { skipped: "OPENROUTER_API_KEY is not set" as const };
    const sites = await step.run("list", () => sitesForAnswerProbes());
    if (sites.length) await step.sendEvent("fan-out", sites.map((s) => answersSampleRequested.create({ siteId: s.site_id, orgId: s.org_id })));
    return { sites: sites.length };
  },
);

export const answersFunctions = [answersSampleFunction, answersSampleWeekly];
