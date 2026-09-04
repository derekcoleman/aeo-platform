"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canManage, requireUser } from "@/lib/auth/session";
import { connectorContext, createConnection, getConnection, updateConnection } from "@/lib/connectors";
import { WebflowApi, WebflowApiError, suggestFieldMap, webflowClientFor, type FieldMap } from "@/lib/connectors/webflow";
import { inngest, publishingPushRequested } from "@/lib/inngest";
import { createWebflowTarget, deletePublishTarget, loadPublishTarget, updatePublishTarget, type WebflowTargetConfig } from "@/lib/publishing/targets";
import type { ActionResult } from "./actions";
import { loadSite } from "./store";

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(siteId: string) {
  const user = await requireUser(`/app/sites/${siteId}/publishing`);
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Site not found." };
  return { user, site, error: canManage(user, site.org_id) ? null : "Only owners and admins manage publishing." };
}

const refresh = (siteId: string) => {
  revalidatePath(`/app/sites/${siteId}/publishing`);
  revalidatePath(`/app/sites/${siteId}/content`);
};

export async function connectWebflowAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const siteId = String(form.get("siteId") ?? "");
  const token = String(form.get("token") ?? "").trim();
  if (token.length < 20) return fail("Paste the site API token (Site settings → Apps & integrations → API access).");
  const { user, site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  let sites;
  try {
    sites = await new WebflowApi(token, fetch, process.env.WEBFLOW_API_BASE || undefined).sites();
  } catch (e) {
    return fail(e instanceof WebflowApiError ? `Webflow rejected the token (${e.status}): ${e.message}` : `Could not reach Webflow: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (sites.length === 0) return fail("The token can see no sites. Create it under the site's Apps & integrations with cms:read and cms:write.");
  const ctx = connectorContext();
  const conn = await createConnection(
    {
      orgId: site.org_id,
      siteId,
      provider: "webflow",
      secret: token,
      config: { sites: sites.map((s) => ({ id: s.id, name: s.displayName, domains: s.customDomains })), checkedAt: new Date().toISOString() },
      externalAccountId: sites[0]!.id,
      externalAccountName: sites.length === 1 ? sites[0]!.displayName : `${sites.length} sites`,
      status: "active",
      createdBy: user.id,
    },
    ctx.secrets,
    ctx.sql,
  );
  refresh(siteId);
  return { ok: true, id: conn.id };
}

const targetForm = z.object({ siteId: z.guid(), connectionId: z.guid(), webflowSiteId: z.string().min(1), collectionId: z.string().min(1) });

export async function createTargetAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = targetForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail("Choose a Webflow site and a collection.");
  const { siteId, connectionId, webflowSiteId, collectionId } = parsed.data;
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  const conn = await getConnection(connectionId);
  if (!conn || conn.provider !== "webflow" || conn.org_id !== site.org_id) return fail("Webflow connection not found.");
  const ctx = connectorContext();
  let detail;
  let wfSite;
  try {
    const api = await webflowClientFor(conn, ctx);
    [detail, wfSite] = await Promise.all([api.collection(collectionId), api.sites().then((s) => s.find((x) => x.id === webflowSiteId) ?? null)]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const fieldMap = suggestFieldMap(detail.fields);
  if (!fieldMap.body) return fail(`Collection "${detail.displayName}" has no rich-text field for the article body. Add one (e.g. "Post body") and try again.`);
  const config: WebflowTargetConfig & { collectionSlug: string; publicDomain: string | null } = {
    siteId: webflowSiteId,
    siteName: wfSite?.displayName ?? webflowSiteId,
    collectionId,
    collectionName: detail.displayName,
    collectionSlug: detail.slug,
    publicDomain: wfSite?.customDomains[0] ?? null,
    fieldMap,
    publishLive: true,
    canonicalMode: "proxy",
    autoPush: true,
  };
  const row = await createWebflowTarget(siteId, connectionId, `Webflow · ${detail.displayName}`, config);
  await updateConnection(conn, { config: { ...conn.config, lastCollection: collectionId } }, ctx.sql).catch(() => undefined);
  refresh(siteId);
  return { ok: true, id: row.id };
}

const mapForm = z.object({
  targetId: z.guid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  body: z.string().min(1),
  summary: z.string().optional().default(""),
  image: z.string().optional().default(""),
  publishedAt: z.string().optional().default(""),
  canonical: z.string().optional().default(""),
  author: z.string().optional().default(""),
  publishLive: z.string().optional().default(""),
  autoPush: z.string().optional().default(""),
  enabled: z.string().optional().default(""),
  canonicalMode: z.enum(["proxy", "webflow", "none"]).default("proxy"),
});

export async function updateTargetAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = mapForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid field map.");
  const d = parsed.data;
  const target = await loadPublishTarget(d.targetId);
  if (!target) return fail("Target not found.");
  const { site, error } = await guard(target.site_id);
  if (!site || error) return fail(error ?? "Site not found.");
  const fieldMap: FieldMap = { name: d.name, slug: d.slug, body: d.body, summary: d.summary || null, image: d.image || null, publishedAt: d.publishedAt || null, canonical: d.canonical || null, author: d.author || null };
  await updatePublishTarget(d.targetId, { config: { ...target.config, fieldMap, publishLive: !!d.publishLive, autoPush: !!d.autoPush, canonicalMode: d.canonicalMode }, enabled: !!d.enabled });
  refresh(target.site_id);
  return { ok: true };
}

export async function deleteTargetAction(siteId: string, targetId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  const target = await loadPublishTarget(targetId);
  if (!target || target.site_id !== siteId) return fail("Target not found.");
  await deletePublishTarget(targetId);
  refresh(siteId);
  return { ok: true };
}

/** Create a draft item and delete it again: proves the token, the collection and the field map without leaving anything behind. */
export async function testTargetAction(siteId: string, targetId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  const target = await loadPublishTarget(targetId);
  if (!target || target.site_id !== siteId || !target.connection_id) return fail("Target not found.");
  const conn = await getConnection(target.connection_id);
  if (!conn) return fail("Connection not found.");
  try {
    const api = await webflowClientFor(conn, connectorContext());
    const m = target.config.fieldMap;
    const item = await api.createItem(target.config.collectionId, { isDraft: true, fieldData: { [m.name]: "AEO Platform connection test", [m.slug]: `aeo-connection-test-${Date.now()}`, [m.body]: "<p>This draft was created and removed by AEO Platform to verify the connection.</p>" } });
    await api.deleteItem(target.config.collectionId, item.id);
    return { ok: true, error: "Draft item created and removed; the collection accepts our field map." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function pushItemAction(siteId: string, contentItemId: string, targetId: string | null, force = true): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  await inngest.send(publishingPushRequested.create({ siteId, orgId: site.org_id, contentItemId, targetId: targetId ?? null, force }));
  return { ok: true };
}
