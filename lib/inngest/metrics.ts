import { appDb } from "@/lib/db/app";
import { METHODOLOGY_VERSION } from "@/lib/app/methodology";
import { auditRestatement, computeRestatement, sitesWithMeasurements } from "@/lib/app/restatement";
import { resolveMetricContentIds } from "@/lib/connectors/store";
import { concurrencyCap, inngest, metricsContentIdsRequested, metricsRestatementRequested } from "./client";

/**
 * One site's connector metrics and owned citations tied to the content items
 * behind the pages they name, over the lookback window
 * (CONTENT_ID_LOOKBACK_DAYS). Fanned out nightly by retention-purge-nightly.
 */
export const metricsContentIdsFunction = inngest.createFunction(
  {
    id: "metrics-content-ids",
    triggers: [metricsContentIdsRequested],
    concurrency: [{ key: "event.data.siteId", limit: 1 }, { limit: concurrencyCap(5) }],
    retries: 1,
  },
  async ({ event, step }) => step.run("resolve", () => resolveMetricContentIds(event.data.siteId)),
);

/**
 * Restatement, on demand from /ops after a methodology change. Without a
 * site, the run lists every measured site and sends one event each, so a
 * large fleet never meets the per-run step limit; with one, it recomputes
 * the old and the new value of every restated metric and leaves an audit
 * row. One run at a time; re-running replaces the rows.
 */
export const metricsRestatementFunction = inngest.createFunction(
  { id: "metrics-restatement", triggers: [metricsRestatementRequested], concurrency: [{ limit: concurrencyCap(1) }], retries: 1 },
  async ({ event, step }) => {
    const { siteId, requestedBy = null } = event.data;
    if (!siteId) {
      const sites = await step.run("list-sites", () => sitesWithMeasurements());
      if (sites.length) await step.sendEvent("fan-out", sites.map((s) => metricsRestatementRequested.create({ siteId: s.id, requestedBy })));
      return { methodologyVersion: METHODOLOGY_VERSION, sites: sites.length };
    }
    const site = await step.run("load-site", async () => {
      const [row] = await appDb()<{ id: string; org_id: string }[]>`select id, org_id from app.sites where id = ${siteId}`;
      return row ?? null;
    });
    if (!site) return { skipped: "site not found" as const };
    const changed = await step.run("restate", async () => {
      const rows = await computeRestatement(site.id);
      await auditRestatement(site, rows, requestedBy);
      return rows.filter((r) => r.oldValue !== r.newValue).length;
    });
    return { methodologyVersion: METHODOLOGY_VERSION, siteId: site.id, changed };
  },
);

export const metricsFunctions = [metricsContentIdsFunction, metricsRestatementFunction];
