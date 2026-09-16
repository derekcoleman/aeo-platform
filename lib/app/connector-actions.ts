"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canManage, requireUser } from "@/lib/auth/session";
import { connectorContext, createConnection, disconnectConnection, getConnection, getConnector, listConnections, updateConnection } from "@/lib/connectors";
import { customConfigSchema, probeApi, probeMcp, type CustomConfig } from "@/lib/connectors/custom";
import { slackConnector } from "@/lib/connectors/slack";
import { markSyncRequested } from "@/lib/connectors/store";
import { ConnectorError } from "@/lib/connectors/types";
import { connectorSyncRequested } from "@/lib/inngest";
import { queueJob } from "@/lib/jobs/dispatch";
import type { ActionResult } from "./actions";
import { loadSite } from "./store";

/**
 * Server actions behind the Connectors page. Every one re-checks that the
 * caller manages the organisation the connection belongs to, writes through
 * the service connection, and queues the sync that makes the change real.
 */

const fail = (error: string): ActionResult => ({ ok: false, error });
const CONNECTORS_PATH = "/settings/connectors";

const refresh = (siteIds: (string | null | undefined)[] = []) => {
  revalidatePath(CONNECTORS_PATH);
  // The connectors tab of the settings hub.
  revalidatePath("/settings");
  // Org-wide rows (Slack, org custom sources) show on every project's page.
  revalidatePath("/app/sites/[siteId]/connectors", "page");
  for (const id of siteIds) if (id) revalidatePath(`/app/sites/${id}`);
};

async function managedConnection(connectionId: string) {
  const user = await requireUser(CONNECTORS_PATH);
  const conn = await getConnection(connectionId);
  if (!conn) return { user, conn: null, error: "Connection not found." };
  return { user, conn, error: canManage(user, conn.org_id) ? null : "Only owners and admins manage connectors." };
}

async function queueSync(connectionId: string, orgId: string, kind: "backfill" | "incremental", label: string): Promise<string | null> {
  const jobError = await queueJob(connectorSyncRequested.create({ connectionId, orgId, kind }), undefined, label);
  if (jobError) return jobError;
  await markSyncRequested(connectionId, kind);
  return null;
}

// ── Google: choose the Search Console property and / or the GA4 property ────

const googleForm = z.object({ connectionId: z.guid(), gscProperty: z.string().trim().max(500).optional().default(""), ga4PropertyId: z.string().trim().max(50).optional().default("") });

export async function configureGoogleAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = googleForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail("Pick a property.");
  const { connectionId, gscProperty, ga4PropertyId } = parsed.data;
  const { conn, error } = await managedConnection(connectionId);
  if (!conn || error) return fail(error ?? "Connection not found.");
  if (conn.provider !== "google") return fail("Not a Google connection.");
  if (!conn.site_id) return fail("This Google grant is not bound to a project; reconnect it from a project.");
  const config = { ...conn.config, gscProperty: gscProperty || null, ga4PropertyId: ga4PropertyId || null };
  const anything = !!(config.gscProperty || config.ga4PropertyId);
  await updateConnection(conn, { config, status: anything ? "active" : "pending", last_error: null });
  refresh([conn.site_id]);
  if (!anything) return { ok: true, note: "Nothing selected; the grant is kept but nothing is read." };
  const jobError = await queueSync(conn.id, conn.org_id, conn.last_synced_at ? "incremental" : "backfill", "Google sync");
  if (jobError) return { ok: true, note: `Saved, but the first sync did not start: ${jobError}` };
  return { ok: true, note: conn.last_synced_at ? "Saved; a sync is queued." : "Saved; the 16-month backfill is queued." };
}

// ── Slack: choose channels, approvals and alerts ────────────────────────────

const slackForm = z.object({ connectionId: z.guid(), approvalsChannel: z.string().trim().max(50).optional().default(""), alertsChannel: z.string().trim().max(50).optional().default("") });

export async function configureSlackAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = slackForm.safeParse({ connectionId: form.get("connectionId"), approvalsChannel: form.get("approvalsChannel"), alertsChannel: form.get("alertsChannel") });
  if (!parsed.success) return fail("Invalid input.");
  const { connectionId, approvalsChannel, alertsChannel } = parsed.data;
  const picked = form.getAll("channels").map(String).filter((v) => /^[A-Z0-9]{5,20}$/.test(v));
  const names = new Map<string, string>();
  for (const [k, v] of form.entries()) {
    const m = /^name:([A-Z0-9]{5,20})$/.exec(k);
    if (m && typeof v === "string") names.set(m[1]!, v);
  }
  const { conn, error } = await managedConnection(connectionId);
  if (!conn || error) return fail(error ?? "Connection not found.");
  if (conn.provider !== "slack") return fail("Not a Slack connection.");
  const channels = picked.map((id) => ({ id, name: names.get(id) ?? id }));
  const config = { ...conn.config, channels, approvalsChannel: approvalsChannel || undefined, alertsChannel: alertsChannel || undefined };
  const next = { ...conn, config, scope: picked };
  try {
    await slackConnector.validate?.(next as never, connectorContext());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  await updateConnection(conn, { config, scope: picked, status: "active", last_error: null });
  refresh();
  if (picked.length === 0) return { ok: true, note: "Saved. No channels are read; approvals and alerts still post if set." };
  const jobError = await queueSync(conn.id, conn.org_id, conn.last_synced_at ? "incremental" : "backfill", "Slack sync");
  if (jobError) return { ok: true, note: `Saved, but the sync did not start: ${jobError}` };
  return { ok: true, note: `Reading ${picked.length} channel${picked.length === 1 ? "" : "s"}; the 90-day backfill is queued.` };
}

// ── Custom: an API endpoint or an MCP server ────────────────────────────────

const customForm = z.object({
  orgId: z.guid(),
  siteId: z.string().trim().optional().default(""),
  kind: z.enum(["api", "mcp"]),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url(),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  headerName: z.string().trim().max(100).optional().default(""),
  secret: z.string().max(4000).optional().default(""),
  itemsPath: z.string().trim().max(200).optional().default(""),
  fieldId: z.string().trim().max(100).optional().default(""),
  fieldTitle: z.string().trim().max(100).optional().default(""),
  fieldText: z.string().trim().max(100).optional().default(""),
  fieldUpdatedAt: z.string().trim().max(100).optional().default(""),
  resourceFilter: z.string().trim().max(500).optional().default(""),
});

export async function connectCustomAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = customForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const d = parsed.data;
  const user = await requireUser(CONNECTORS_PATH);
  if (!canManage(user, d.orgId)) return fail("Only owners and admins manage connectors.");
  const siteId = d.siteId || null;
  if (siteId) {
    const site = await loadSite(siteId);
    if (!site || site.org_id !== d.orgId) return fail("Project not found.");
  }
  if (d.authType !== "none" && !d.secret.trim()) return fail("Enter the token for the chosen authentication.");
  const cfg: CustomConfig = customConfigSchema.parse({
    kind: d.kind,
    name: d.name,
    url: d.url,
    auth: { type: d.authType, ...(d.authType === "header" ? { headerName: d.headerName || "X-API-Key" } : {}) },
    itemsPath: d.itemsPath,
    fields: { id: d.fieldId, title: d.fieldTitle, text: d.fieldText, updatedAt: d.fieldUpdatedAt },
    resourceFilter: d.resourceFilter,
  });
  const ctx = connectorContext();
  const secret = d.authType === "none" ? null : d.secret.trim();
  let note: string;
  try {
    if (cfg.kind === "mcp") {
      const p = await probeMcp(cfg, secret, ctx);
      if (p.matched === 0) return fail(`Connected to ${p.server?.name ?? "the server"} but it lists no resources${cfg.resourceFilter ? ` under "${cfg.resourceFilter}"` : ""} (${p.resources} in total). Nothing would be read.`);
      note = `${p.server?.name ?? "MCP server"} lists ${p.matched} resource${p.matched === 1 ? "" : "s"} (e.g. ${p.sample.slice(0, 3).join(", ")}).`;
    } else {
      const p = await probeApi(cfg, secret, ctx, siteId);
      if (p.documents.length === 0) return fail(`The endpoint answered ${p.status} (${p.contentType || "no content type"}) but produced no documents: ${p.note ?? "empty response"}.`);
      note = `The endpoint answered ${p.status} with ${p.documents.length} document${p.documents.length === 1 ? "" : "s"} (first: “${(p.documents[0]!.title ?? p.documents[0]!.externalId).slice(0, 60)}”).`;
    }
  } catch (e) {
    if (e instanceof ConnectorError) return fail(e.message);
    return fail(`Could not reach ${cfg.url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const conn = await createConnection(
    { orgId: d.orgId, siteId, provider: "custom", secret, config: cfg, externalAccountId: cfg.url, externalAccountName: cfg.name, status: "active", createdBy: user.id },
    ctx.secrets,
    ctx.sql,
  );
  refresh([siteId]);
  const jobError = await queueSync(conn.id, d.orgId, "backfill", "custom source sync");
  if (jobError) return { ok: true, id: conn.id, note: `${note} Saved, but the first sync did not start: ${jobError}` };
  return { ok: true, id: conn.id, note: `${note} The first sync is queued.` };
}

// ── shared: disconnect, sync now, ensure the website crawl exists ───────────

export async function disconnectConnectionAction(connectionId: string): Promise<ActionResult> {
  const { conn, error } = await managedConnection(connectionId);
  if (!conn || error) return fail(error ?? "Connection not found.");
  const ctx = connectorContext();
  try {
    await getConnector(conn.provider).disconnect?.(conn as never, ctx);
  } catch (e) {
    console.warn(`[connectors] provider-side disconnect failed for ${conn.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  await disconnectConnection(conn, ctx.secrets, ctx.sql);
  refresh([conn.site_id]);
  return { ok: true };
}

export async function syncConnectionAction(connectionId: string): Promise<ActionResult> {
  const { conn, error } = await managedConnection(connectionId);
  if (!conn || error) return fail(error ?? "Connection not found.");
  if (!conn.enabled || conn.status === "disconnected" || conn.status === "disabled") return fail(`Connection is ${conn.status}.`);
  if (conn.provider === "profound" && (conn.config as { mode?: string }).mode !== "api") return fail("This Profound connection only accepts CSV uploads.");
  const kind = conn.last_synced_at ? "incremental" : "backfill";
  const jobError = await queueSync(conn.id, conn.org_id, kind, `${conn.provider} sync`);
  if (jobError) return fail(jobError);
  refresh([conn.site_id]);
  return { ok: true, note: kind === "backfill" ? "Backfill queued." : "Sync queued." };
}

/** The website crawl is created with the project; this recreates it if it was disconnected. */
export async function ensureWebsiteConnectionAction(siteId: string): Promise<ActionResult> {
  const user = await requireUser(CONNECTORS_PATH);
  const site = await loadSite(siteId);
  if (!site) return fail("Project not found.");
  if (!canManage(user, site.org_id)) return fail("Only owners and admins manage connectors.");
  const existing = (await listConnections({ orgId: site.org_id, provider: "website" })).find((c) => c.site_id === siteId && c.status !== "disconnected");
  if (existing) return { ok: true, id: existing.id, note: "Already connected." };
  const ctx = connectorContext();
  const conn = await createConnection(
    { orgId: site.org_id, siteId, provider: "website", status: "active", config: { origin: `https://${site.canonical_domain}`, maxPages: 20 }, externalAccountId: site.canonical_domain, externalAccountName: site.canonical_domain, createdBy: user.id },
    ctx.secrets,
    ctx.sql,
  );
  refresh([siteId]);
  const jobError = await queueSync(conn.id, site.org_id, "backfill", "website crawl");
  if (jobError) return { ok: true, id: conn.id, note: `Created, but the crawl did not start: ${jobError}` };
  return { ok: true, id: conn.id, note: "Crawl queued." };
}
