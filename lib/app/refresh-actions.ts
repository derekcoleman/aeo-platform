"use server";

import { revalidatePath } from "next/cache";
import { canEdit, canManage, requireUser } from "@/lib/auth/session";
import { getConnection, listConnections } from "@/lib/connectors/store";
import { appDb } from "@/lib/db/app";
import { connectorSyncRequested, contentPipelineRequested, refreshScanRequested } from "@/lib/inngest";
import { queueJob } from "@/lib/jobs/dispatch";
import { markOpportunity } from "@/lib/pipeline/opportunities";
import { queueRefreshForItem } from "@/lib/refresh/scan";
import type { ActionResult } from "./actions";
import { loadSite } from "./store";

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(siteId: string, need: "edit" | "manage") {
  const user = await requireUser(`/app/sites/${siteId}/refresh`);
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Site not found." };
  const allowed = need === "manage" ? canManage(user, site.org_id) : canEdit(user, site.org_id);
  return { user, site, error: allowed ? null : "You do not have access to this project." };
}

const refresh = (siteId: string) => {
  revalidatePath(`/app/sites/${siteId}/refresh`);
  revalidatePath(`/app/sites/${siteId}`);
};

/** Pull the CMS inventory now (the daily sync does the same); the scan follows automatically. */
export async function syncInventoryAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Site not found.");
  const conns = (await listConnections({ orgId: site.org_id, provider: "webflow", activeOnly: true })).filter((c) => !c.site_id || c.site_id === siteId);
  const conn = conns.find((c) => c.site_id === siteId) ?? conns[0];
  if (!conn) return fail("Connect Webflow under Publishing first.");
  const jobError = await queueJob(connectorSyncRequested.create({ connectionId: conn.id, orgId: site.org_id, kind: conn.last_synced_at ? "incremental" : "backfill" }), undefined, "webflow inventory sync");
  if (jobError) return fail(jobError);
  refresh(siteId);
  return { ok: true, note: "Inventory sync queued; the scores update when it lands." };
}

/** Re-score the inventory against the latest traffic and citation data and refill the queue. */
export async function rescoreRefreshAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const jobError = await queueJob(refreshScanRequested.create({ siteId, orgId: site.org_id }), undefined, "refresh scan");
  if (jobError) return fail(jobError);
  refresh(siteId);
  return { ok: true };
}

/** Send one CMS item through the pipeline now, whatever its score. */
export async function refreshItemAction(siteId: string, cmsItemId: string, note?: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const sql = appDb();
  const [item] = await sql<{ id: string; connection_id: string; is_draft: boolean; is_archived: boolean; has_body: boolean }[]>`
    select id, connection_id, is_draft, is_archived, (body_html is not null) as has_body from content.cms_items where id = ${cmsItemId} and site_id = ${siteId}`;
  if (!item) return fail("CMS item not found.");
  if (!item.has_body) return fail("This collection has no rich-text body field, so there is nothing to rewrite.");
  const conn = await getConnection(item.connection_id, sql);
  if (!conn || conn.status !== "active") return fail("The Webflow connection is not active.");
  const opp = await queueRefreshForItem(cmsItemId, sql);
  if (!opp) return fail("Could not open a refresh opportunity for this item.");
  if (opp.status !== "open") return fail(`A refresh is already ${opp.status} for this item.`);
  await markOpportunity(opp.id, "queued", sql);
  const jobError = await queueJob(contentPipelineRequested.create({ opportunityId: opp.id, siteId, orgId: site.org_id, note: note?.trim() || null }));
  if (jobError) {
    await markOpportunity(opp.id, "open", sql);
    return fail(jobError);
  }
  refresh(siteId);
  return { ok: true, id: opp.id, note: "Brief → draft → QA → approval, then the post is updated in place." };
}
