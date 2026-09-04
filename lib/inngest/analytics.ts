import { BOT_CATALOG, fetchPublishedRanges } from "@/lib/analytics/bots";
import { rollupCrawlDaily, saveBotRanges } from "@/lib/analytics/crawl";
import { inngest } from "./client";

/** Hourly: re-aggregate the last two days of raw events into crawl_daily. Idempotent. */
export const crawlRollupHourly = inngest.createFunction(
  { id: "crawl-rollup-hourly", triggers: [{ cron: "7 * * * *" }], retries: 1 },
  async ({ step }) => {
    const rows = await step.run("rollup", () => rollupCrawlDaily(2));
    return { rows };
  },
);

/** Daily: refresh every operator's published IP ranges. A failed fetch keeps yesterday's list. */
export const botsRefreshDaily = inngest.createFunction(
  { id: "bots-refresh-daily", triggers: [{ cron: "0 6 * * *" }], retries: 1 },
  async ({ step }) => {
    const results: { family: string; ranges?: number; error?: string }[] = [];
    for (const bot of BOT_CATALOG) {
      const url = bot.rangesUrl;
      if (!url) continue;
      const result = await step.run(`ranges-${bot.family}`, async () => {
        try {
          const ranges = await fetchPublishedRanges(url);
          if (ranges.length > 0) await saveBotRanges(bot.family, ranges);
          return { family: bot.family, ranges: ranges.length };
        } catch (err) {
          return { family: bot.family, error: err instanceof Error ? err.message : String(err) };
        }
      });
      results.push(result);
    }
    return { results };
  },
);

export const analyticsFunctions = [crawlRollupHourly, botsRefreshDaily];
