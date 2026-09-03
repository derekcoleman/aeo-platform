import { defaultEmbedder } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import { buildQuestionGraph } from "@/lib/demand/question-graph";
import { listTrackedQuestions, loadSiteOwnership, recordSnapshot, upsertQuestionGraph, type TrackedQuestion } from "@/lib/demand/store";
import { BudgetExceededError, serpClientFromEnv } from "@/lib/serp";
import { demandMineCompleted, demandMineRequested, inngest, serpTrackCompleted, serpTrackRequested } from "./client";

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

export const demandMineFunction = inngest.createFunction(
  {
    id: "demand-mine",
    triggers: [demandMineRequested],
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: 5 }],
    retries: 1,
  },
  async ({ event, step }) => {
    const { siteId, orgId, seeds, locale, device = "desktop", depth, maxQueries, paa, trackTop } = event.data;

    // Build and persist in one step: a memoized graph would carry every
    // embedding (1536 floats × N questions) through Inngest's step store,
    // and the day cache already makes a retry cheap.
    const mined = await step.run("mine-and-persist", async () => {
      const client = serpClientFromEnv();
      const embedder = defaultEmbedder();
      const graph = await buildQuestionGraph(client, { orgId, siteId }, { seeds, locale, device, depth, maxQueries, paa, embedder });
      const r = await upsertQuestionGraph(siteId, graph, {
        locale: `${locale.country}-${locale.language}`,
        device,
        embeddingModel: graph.stats.embeddingModel,
      });
      return { inserted: r.inserted, updated: r.updated, stats: graph.stats };
    });

    if (trackTop && trackTop > 0) {
      await step.run("auto-track", async () => {
        const sql = appDb();
        await sql`
          with top as (
            select id from measure.questions
            where site_id = ${siteId} and not is_tracked
            order by demand_score desc, seen_count desc
            limit ${trackTop}
          )
          update measure.questions q set is_tracked = true, tracking_tier = 'weekly'
          from top where q.id = top.id`;
      });
    }

    const summary = {
      siteId,
      orgId,
      inserted: mined.inserted,
      updated: mined.updated,
      queriesIssued: mined.stats.queriesIssued,
      costUsd: mined.stats.costUsd,
    };
    await step.sendEvent("notify", demandMineCompleted.create(summary));
    return summary;
  },
);

export const serpTrackFunction = inngest.createFunction(
  {
    id: "serp-track",
    triggers: [serpTrackRequested],
    concurrency: [{ key: "event.data.orgId", limit: 2 }, { limit: 10 }],
    retries: 2,
  },
  async ({ event, step }) => {
    const { siteId, orgId, questionIds } = event.data;

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
    let snapshots = 0;
    let aioTriggered = 0;
    let ownedCitations = 0;
    let costUsd = 0;
    let budgetStopped = false;
    for (const q of questions) {
      const r = await step.run(`snapshot:${q.id}`, async () => {
        const [country = "us", language = "en"] = q.locale.split("-");
        const client = serpClientFromEnv();
        try {
          const result = await client.aioSerp(
            { query: q.text, locale: { country, language }, device: q.device as "desktop" | "mobile" },
            { orgId, siteId },
          );
          const rec = await recordSnapshot(own, q.id, result);
          return { ok: true as const, aio: rec.aioTriggered === true, owned: rec.ownedCitations, cost: result.cached ? 0 : result.costUsd };
        } catch (e) {
          if (e instanceof BudgetExceededError) return { ok: false as const, budget: true as const };
          throw e;
        }
      });
      if (!r.ok) {
        budgetStopped = true;
        break;
      }
      snapshots += 1;
      if (r.aio) aioTriggered += 1;
      ownedCitations += r.owned;
      costUsd += r.cost;
    }

    const summary = { siteId, orgId, snapshots, aioTriggered, ownedCitations, costUsd };
    await step.sendEvent("notify", serpTrackCompleted.create(summary));
    return { ...summary, budgetStopped };
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
