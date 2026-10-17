import { defaultEmbedder } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import { discoverQuestions, finalizeQuestionGraph, mergeQuestionNodes, type QuestionGraphStats, type QuestionNode } from "@/lib/demand/question-graph";
import { autoTrackQuestions, listTrackedQuestions, loadSiteOwnership, recordSnapshot, upsertQuestionGraph, type TrackedQuestion } from "@/lib/demand/store";
import { BudgetExceededError, SerpProviderError, serpClientFromEnv } from "@/lib/serp";
import { concurrencyCap, demandMineCompleted, demandMineRequested, inngest, serpTrackCompleted, serpTrackRequested } from "./client";

/**
 * Demand mining and AI Overview citation tracking.
 *
 * Two jobs and a scheduler. Mining is bursty (hundreds of cheap autocomplete
 * calls per seed set) and tracking is recurring (one high-fidelity SERP per
 * tracked question per tier), so both carry per-org concurrency and the
 * scheduler fans out per site rather than running every tenant in one step —
 * a budget-exhausted org must fail alone.
 */

const TRACK_BATCH = 50;
const TRACK_RETRIES = 2;
/** Seeds discovered per durable step: small enough that one step finishes well inside a function's time limit. */
export const MINE_SEED_BATCH = 5;
const DEFAULT_MAX_QUERIES = 300;

/** Split a seed list into the batches demand-mine discovers one step each. Pure. */
export function seedBatches(seeds: string[], size = MINE_SEED_BATCH): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < seeds.length; i += Math.max(1, size)) out.push(seeds.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * What serp-track does with a question whose snapshot failed. A budget stop
 * halts the batch. A vendor that refused the query (SerpProviderError: a 4xx,
 * a task error) will refuse it again, so it is recorded on the question and
 * skipped. Anything else (a timeout, a 5xx or 429 that outlasted the client's
 * own retries, a dropped connection, a database blip) is thrown for Inngest
 * to retry the step, and recorded and skipped only on the last attempt. Pure.
 */
export function snapshotFailure(error: unknown, attempt: number, retries = TRACK_RETRIES): "budget" | "retry" | "record" {
  if (error instanceof BudgetExceededError) return "budget";
  if (error instanceof SerpProviderError || attempt >= retries) return "record";
  return "retry";
}

export const demandMineFunction = inngest.createFunction(
  {
    id: "demand-mine",
    triggers: [demandMineRequested],
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: concurrencyCap(5) }],
    retries: 1,
  },
  async ({ event, step, runId }) => {
    const { siteId, orgId, seeds, locale, device = "desktop", depth, maxQueries, paa, trackTop } = event.data;

    // Discovery runs one step per batch of seeds: one step for 50 seeds could
    // outlive the function's time limit and start over, and the day cache
    // makes a retried batch cheap. Each batch returns only its nodes (no
    // embeddings, which would carry 1536 floats × N questions through
    // Inngest's step store) and skips what earlier batches issued and found.
    // Scoring, near-duplicate merging and clustering then run once over the
    // whole run in the persist step, so a question several batches surfaced
    // is scored on all its sightings, as one graph over every seed would be.
    // The query budget is shared out evenly; the run id keeps a retried
    // persist step from counting sightings twice.
    const batches = seedBatches(seeds);
    const perBatch = Math.max(1, Math.floor((maxQueries ?? DEFAULT_MAX_QUERIES) / batches.length));
    const found: QuestionNode[][] = [];
    const issued: string[] = [];
    const stats: QuestionGraphStats = { queriesIssued: 0, cachedQueries: 0, costUsd: 0, rawCandidates: 0 };
    for (let i = 0; i < batches.length; i++) {
      const prior = { issued: [...issued], seen: found.flat().map((n) => n.normalized) };
      const d = await step.run(`mine:batch:${i}`, () =>
        discoverQuestions(serpClientFromEnv(), { orgId, siteId }, { seeds: batches[i]!, locale, device, depth, maxQueries: perBatch, paa, prior }),
      );
      found.push(d.nodes);
      issued.push(...d.issued);
      stats.queriesIssued += d.stats.queriesIssued;
      stats.cachedQueries += d.stats.cachedQueries;
      stats.costUsd += d.stats.costUsd;
      stats.rawCandidates += d.stats.rawCandidates;
    }

    const mined = await step.run("persist", async () => {
      const graph = await finalizeQuestionGraph(mergeQuestionNodes(found), stats, { embedder: defaultEmbedder() });
      const up = await upsertQuestionGraph(siteId, graph, {
        locale: `${locale.country}-${locale.language}`,
        device,
        embeddingModel: graph.stats.embeddingModel,
        batchKey: runId,
      });
      return { inserted: up.inserted, updated: up.updated };
    });

    if (trackTop && trackTop > 0) {
      await step.run("auto-track", () => autoTrackQuestions(siteId, trackTop));
    }

    const summary = {
      siteId,
      orgId,
      inserted: mined.inserted,
      updated: mined.updated,
      queriesIssued: stats.queriesIssued,
      costUsd: stats.costUsd,
    };
    await step.sendEvent("notify", demandMineCompleted.create(summary));
    return summary;
  },
);

export const serpTrackFunction = inngest.createFunction(
  {
    id: "serp-track",
    triggers: [serpTrackRequested],
    concurrency: [{ key: "event.data.orgId", limit: 2 }, { limit: concurrencyCap(10) }],
    retries: TRACK_RETRIES,
  },
  async ({ event, step, attempt }) => {
    const { siteId, orgId, questionIds } = event.data;

    // Memoised for the whole run, so it carries only the site's domains:
    // recordSnapshot reads the competitors and overrides it classifies
    // citations with when it writes them.
    const own = await step.run("load-site", () => loadSiteOwnership(siteId));
    if (!own) return { skipped: "site not found" as const };

    const questions = await step.run("load-questions", async () => {
      const sql = appDb();
      return sql<Pick<TrackedQuestion, "id" | "text" | "locale" | "device">[]>`
        select id, text, locale, device from measure.questions
        where site_id = ${siteId} and id = any(${questionIds}::uuid[])`;
    });

    // One step per question so a retry after a provider blip re-pays only
    // the calls that had not completed, and a budget stop is a clean halt.
    // A question the vendor refuses, or one that still fails on the step's
    // last attempt, is recorded on the question and skipped (snapshotFailure),
    // so one bad query does not stop the rest of the batch from being measured.
    let snapshots = 0;
    let aioTriggered = 0;
    let ownedCitations = 0;
    let costUsd = 0;
    let failed = 0;
    let budgetStopped = false;
    for (const q of questions) {
      const r = await step.run(`snapshot:${q.id}`, async () => {
        const [country = "us", language = "en"] = q.locale.split("-");
        // Outside the try: no vendor configured fails the run, not every question.
        const client = serpClientFromEnv();
        try {
          const result = await client.aioSerp(
            { query: q.text, locale: { country, language }, device: q.device as "desktop" | "mobile" },
            { orgId, siteId },
          );
          const rec = await recordSnapshot(own, q.id, result);
          await appDb()`update measure.questions set last_measure_error = null, last_measure_error_at = null where id = ${q.id} and last_measure_error is not null`;
          return { ok: true as const, aio: rec.aioTriggered === true, owned: rec.ownedCitations, cost: result.cached ? 0 : result.costUsd };
        } catch (e) {
          const next = snapshotFailure(e, attempt);
          if (next === "budget") return { ok: false as const, budget: true as const };
          if (next === "retry") throw e;
          const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
          await appDb()`update measure.questions set last_measure_error = ${message}, last_measure_error_at = now() where id = ${q.id}`;
          return { ok: false as const, budget: false as const, error: message };
        }
      });
      if (!r.ok) {
        if (r.budget) {
          budgetStopped = true;
          break;
        }
        failed += 1;
        continue;
      }
      snapshots += 1;
      if (r.aio) aioTriggered += 1;
      ownedCitations += r.owned;
      costUsd += r.cost;
    }

    const summary = { siteId, orgId, snapshots, aioTriggered, ownedCitations, costUsd, failed, budgetStopped };
    await step.sendEvent("notify", serpTrackCompleted.create(summary));
    return summary;
  },
);

/** Group tracked questions by site and emit one track event per batch. */
export function batchBySite(rows: TrackedQuestion[], batch = TRACK_BATCH): { siteId: string; orgId: string; questionIds: string[] }[] {
  const bySite = new Map<string, { orgId: string; ids: string[] }>();
  for (const r of rows) {
    const s = bySite.get(r.site_id) ?? { orgId: r.org_id, ids: [] };
    s.ids.push(r.id);
    bySite.set(r.site_id, s);
  }
  const out: { siteId: string; orgId: string; questionIds: string[] }[] = [];
  for (const [siteId, { orgId, ids }] of bySite) {
    for (let i = 0; i < ids.length; i += batch) out.push({ siteId, orgId, questionIds: ids.slice(i, i + batch) });
  }
  return out;
}

function scheduler(id: string, cron: string, tier: TrackedQuestion["tracking_tier"]) {
  return inngest.createFunction(
    { id, triggers: [{ cron }], retries: 0 },
    async ({ step }) => {
      const rows = await step.run("list", () => listTrackedQuestions(tier));
      const batches = batchBySite(rows);
      if (batches.length === 0) return { tier, sites: 0, questions: 0 };
      await step.sendEvent("fan-out", batches.map((b) => serpTrackRequested.create(b)));
      return { tier, sites: new Set(batches.map((b) => b.siteId)).size, questions: rows.length };
    },
  );
}

/** Daily for the money questions, weekly for the tracked set, monthly for the long tail. */
export const serpTrackDaily = scheduler("serp-track-daily", "0 6 * * *", "daily");
export const serpTrackWeekly = scheduler("serp-track-weekly", "0 7 * * 1", "weekly");
export const serpTrackMonthly = scheduler("serp-track-monthly", "0 8 1 * *", "monthly");

export const demandFunctions = [demandMineFunction, serpTrackFunction, serpTrackDaily, serpTrackWeekly, serpTrackMonthly];
