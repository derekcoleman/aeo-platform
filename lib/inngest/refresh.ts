import { getConnection } from "@/lib/connectors/store";
import { appDb } from "@/lib/db/app";
import { scanRefresh } from "@/lib/refresh/scan";
import { connectorSyncCompleted, inngest, refreshScanRequested } from "./client";

/**
 * The refresh loop's scheduler. The scan itself is one step (a per-site
 * query plus a handful of writes); it runs nightly after the connectors
 * (05:00) and the SERP trackers have landed, on demand from the Refresh page,
 * and right after a Webflow inventory sync so a newly connected site sees
 * its candidates without waiting for the night.
 */
export const refreshScanFunction = inngest.createFunction(
  { id: "refresh-scan", triggers: [{ event: refreshScanRequested }], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 1 },
  async ({ event, step }) => step.run("scan", () => scanRefresh(event.data.siteId)),
);

export const refreshScanNightly = inngest.createFunction(
  { id: "refresh-scan-nightly", triggers: [{ cron: "30 9 * * *" }], retries: 0 },
  async ({ step }) => {
    const sites = await step.run("list-sites", () => appDb()<{ site_id: string; org_id: string }[]>`
      select distinct c.site_id, c.org_id from context.context_connections c join app.sites s on s.id = c.site_id
      where c.provider = 'webflow' and c.enabled and c.status in ('active', 'error') and s.status in ('active', 'verifying')`);
    if (sites.length === 0) return { sites: 0 };
    await step.sendEvent("fan-out", sites.map((s) => refreshScanRequested.create({ siteId: s.site_id, orgId: s.org_id })));
    return { sites: sites.length };
  },
);

/** A successful Webflow inventory sync is followed by a scan of that site. */
export const refreshScanAfterInventory = inngest.createFunction(
  { id: "refresh-scan-after-inventory", triggers: [{ event: connectorSyncCompleted, if: "event.data.provider == 'webflow' && event.data.ok == true" }], retries: 1 },
  async ({ event, step }) => {
    const conn = await step.run("load-connection", () => getConnection(event.data.connectionId));
    if (!conn?.site_id) return { skipped: "connection has no site" as const };
    await step.sendEvent("scan", refreshScanRequested.create({ siteId: conn.site_id, orgId: conn.org_id }));
    return { siteId: conn.site_id };
  },
);

export const refreshFunctions = [refreshScanFunction, refreshScanNightly, refreshScanAfterInventory];
