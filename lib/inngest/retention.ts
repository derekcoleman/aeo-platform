import { sitesWithResolvableContent } from "@/lib/connectors/store";
import { purgeExpired } from "@/lib/ops/retention";
import { inngest, metricsContentIdsRequested } from "./client";

/**
 * Nightly at 03:30 UTC. Idempotent; a missed night is caught up by the next.
 * After the purge, every site where a row could resolve gets a
 * metrics-content-ids run (lib/inngest/metrics.ts) tying connector metrics
 * and owned citations that name a page to its content item: a sync resolves
 * what it wrote, this catches rows whose asset appeared later (a CMS post
 * linked for a refresh). One event per site, not one step per site, so the
 * night's work never meets the per-run step limit.
 */
export const retentionPurgeNightly = inngest.createFunction(
  { id: "retention-purge-nightly", triggers: [{ cron: "30 3 * * *" }], retries: 1 },
  async ({ step }) => {
    const summary = await step.run("purge", () => purgeExpired());
    const sites = await step.run("list-resolvable-sites", () => sitesWithResolvableContent());
    if (sites.length) await step.sendEvent("content-ids", sites.map((s) => metricsContentIdsRequested.create({ siteId: s.id, orgId: s.org_id })));
    return { ...summary, contentIds: { sites: sites.length } };
  },
);

export const retentionFunctions = [retentionPurgeNightly];
