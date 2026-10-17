import { appDb } from "@/lib/db/app";
import type { GateStep } from "@/lib/pipeline/gate";
import { postgresBudget } from "@/lib/serp/budget";
import { postgresCache } from "@/lib/serp/cache";
import { dataForSeoLabs, rankedKeywordsCached, type RankedKeywordsResult } from "@/lib/serp/dataforseo-labs";
import { dataForSeoConfigured } from "@/lib/serp/env";
import {
  COMPETITOR_TOP_RANK,
  computeOrganicGap,
  GAP_FETCH_RETRIES,
  gapFetchFailure,
  loadGapPlan,
  persistOrganicGap,
  sitesForCompetitorGap,
  STRIKING_DISTANCE_MAX_RANK,
  type GapPlan,
  type GapPlanResult,
  type PersistGapInput,
  type PersistGapSummary,
} from "@/lib/strategy/competitor-gap";
import { analyzeCompetitors } from "@/lib/strategy/competitors";
import { assignQuestionsToTopics } from "@/lib/strategy/topics";
import { concurrencyCap, inngest, strategyCompetitorGapRequested, strategyCompetitorsAnalyzeRequested } from "./client";

/**
 * Competitor content analysis: fetch and score the pages currently cited
 * for a site's tracked questions. Per-site concurrency 1 (it fetches other
 * people's sites; be polite), weekly for every active site, on demand from
 * the strategy page.
 */
export const strategyCompetitorsAnalyze = inngest.createFunction(
  {
    id: "strategy-competitors-analyze",
    triggers: [{ event: strategyCompetitorsAnalyzeRequested }],
    concurrency: [{ key: "event.data.siteId", limit: 1 }, { limit: concurrencyCap(4) }],
    retries: 1,
  },
  async ({ event, step }) => {
    const { siteId, topicId, limit } = event.data;
    const assigned = await step.run("assign-topics", () => assignQuestionsToTopics(siteId));
    const summary = await step.run("analyze", () => analyzeCompetitors(siteId, { topicId: topicId ?? null, limit: limit ?? 40 }));
    return { assigned, ...summary };
  },
);

export const strategyCompetitorsWeekly = inngest.createFunction(
  { id: "strategy-competitors-weekly", triggers: [{ cron: "0 4 * * 1" }], retries: 0 },
  async ({ step }) => {
    const sites = await step.run("list-sites", () => appDb()<{ id: string; org_id: string }[]>`select id, org_id from app.sites where status in ('active', 'verifying')`);
    if (sites.length === 0) return { sites: 0 };
    await step.sendEvent("fan-out", sites.map((s) => strategyCompetitorsAnalyzeRequested.create({ siteId: s.id, orgId: s.org_id })));
    return { sites: sites.length };
  },
);

// ── competitor organic gap ──────────────────────────────────────────────────

/**
 * The competitor organic gap (lib/strategy/competitor-gap.ts): one durable
 * step for the site's own rankings, one per named competitor domain (up to
 * five), then one that computes the gap and stores it. A fetch already paid
 * for is not paid again on a retry (the step is memoised, and the month's
 * cache holds the result for any other run). A competitor whose fetch fails
 * is skipped and keeps last month's rows; without the site's own rankings
 * there is no gap to compute, and the run stops. A spent SERP budget stops
 * the fetches, and what was fetched is still stored.
 */
export interface CompetitorGapDeps {
  configured(): boolean;
  loadPlan(siteId: string, orgId: string): Promise<GapPlanResult>;
  rankedKeywords(plan: GapPlan, target: string, maxRank: number): Promise<RankedKeywordsResult & { cached: boolean }>;
  persist(input: PersistGapInput): Promise<PersistGapSummary>;
}

const liveGapDeps: CompetitorGapDeps = {
  configured: () => dataForSeoConfigured(),
  loadPlan: (siteId, orgId) => loadGapPlan(siteId, orgId),
  rankedKeywords: (plan, target, maxRank) => {
    const sql = appDb();
    return rankedKeywordsCached(
      { target, locale: plan.market, maxRank },
      { orgId: plan.orgId, siteId: plan.siteId },
      { labs: dataForSeoLabs(), cache: postgresCache(sql), budget: postgresBudget(sql), month: plan.month },
    );
  },
  persist: (input) => persistOrganicGap(input),
};

export async function runCompetitorGap(
  step: Pick<GateStep, "run">,
  run: { siteId: string; orgId: string; attempt: number },
  deps: CompetitorGapDeps = liveGapDeps,
) {
  const { siteId, orgId, attempt } = run;
  if (!deps.configured()) return { skipped: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set" as const };
  // Read once and memoised: a run keeps the competitors, market and month it started with.
  const loaded = await step.run("load-plan", () => deps.loadPlan(siteId, orgId));
  if ("skipped" in loaded) return { skipped: loaded.skipped };
  const plan: GapPlan = loaded.plan;

  const fetch = (id: string, domain: string, maxRank: number) =>
    step.run(id, async () => {
      try {
        const r = await deps.rankedKeywords(plan, domain, maxRank);
        return { ok: true as const, truncated: r.truncated, keywords: r.keywords, cached: r.cached, costUsd: r.cached ? 0 : r.costUsd, localeFallback: r.localeFallback };
      } catch (e) {
        const next = gapFetchFailure(e, attempt);
        if (next === "retry") throw e;
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        if (next === "skip") console.warn(`[competitor-gap] ranked keywords for ${domain} (site ${siteId}) skipped: ${error}`);
        return { ok: false as const, budget: next === "budget", error };
      }
    });

  let costUsd = 0;
  let cached = 0;
  const own = await fetch("ranked:own", plan.brand, STRIKING_DISTANCE_MAX_RANK);
  if (!own.ok) return { siteId, stopped: own.budget ? ("budget" as const) : ("own rankings unavailable" as const), error: own.error };
  costUsd += own.costUsd;
  if (own.cached) cached++;

  const fetched: (GapPlan["competitors"][number] & { truncated: boolean; keywords: typeof own.keywords })[] = [];
  let failed = 0;
  let budgetStopped = false;
  for (const c of plan.competitors) {
    const r = await fetch(`ranked:${c.domain}`, c.domain, COMPETITOR_TOP_RANK);
    if (!r.ok) {
      if (r.budget) {
        budgetStopped = true;
        break;
      }
      failed++;
      continue;
    }
    costUsd += r.costUsd;
    if (r.cached) cached++;
    fetched.push({ ...c, truncated: r.truncated, keywords: r.keywords });
  }
  const summary = { siteId, competitors: fetched.length, failed, cached, costUsd, budgetStopped, localeFallback: own.localeFallback };
  if (fetched.length === 0) return { ...summary, keywords: 0 };

  const stored = await step.run("persist", async () => {
    const gap = computeOrganicGap({ domain: plan.brand, truncated: own.truncated, keywords: own.keywords }, fetched, { brandedTerms: plan.brandedTerms });
    const persisted = await deps.persist({
      siteId,
      locale: plan.locale,
      gap,
      fetchedDomains: fetched.map((f) => f.domain),
      plannedDomains: plan.competitors.map((c) => c.domain),
      fetchedAt: new Date().toISOString(),
    });
    return { ...persisted, gap: { keywords: gap.rows.length, covered: gap.covered, branded: gap.branded, unknown: gap.unknown } };
  });
  return { ...summary, ...stored };
}

export const strategyCompetitorGap = inngest.createFunction(
  {
    id: "strategy-competitor-gap",
    triggers: [{ event: strategyCompetitorGapRequested }],
    concurrency: [{ key: "event.data.siteId", limit: 1 }, { limit: concurrencyCap(2) }],
    retries: GAP_FETCH_RETRIES,
  },
  async ({ event, step, attempt }) => runCompetitorGap(step, { siteId: event.data.siteId, orgId: event.data.orgId, attempt }),
);

/** The 2nd of each month, 11:00 UTC: every tracked site whose org names a competitor with a domain. */
export const strategyCompetitorGapMonthly = inngest.createFunction(
  { id: "strategy-competitor-gap-monthly", triggers: [{ cron: "0 11 2 * *" }], concurrency: [{ limit: concurrencyCap(1) }], retries: 0 },
  async ({ step }) => {
    if (!dataForSeoConfigured()) return { skipped: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set" as const };
    const sites = await step.run("list-sites", () => sitesForCompetitorGap());
    if (sites.length) await step.sendEvent("fan-out", sites.map((s) => strategyCompetitorGapRequested.create({ siteId: s.site_id, orgId: s.org_id })));
    return { sites: sites.length };
  },
);

export const strategyFunctions = [strategyCompetitorsAnalyze, strategyCompetitorsWeekly, strategyCompetitorGap, strategyCompetitorGapMonthly];
