import { appDb } from "@/lib/db/app";
import { analyzeCompetitors } from "@/lib/strategy/competitors";
import { assignQuestionsToTopics } from "@/lib/strategy/topics";
import { inngest, strategyCompetitorsAnalyzeRequested } from "./client";

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
    concurrency: [{ key: "event.data.siteId", limit: 1 }, { limit: 4 }],
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

export const strategyFunctions = [strategyCompetitorsAnalyze, strategyCompetitorsWeekly];
