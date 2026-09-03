"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { canEdit, canManage, requireStaff, requireUser } from "@/lib/auth/session";
import { setFeature } from "@/lib/connectors/store";
import { appDb } from "@/lib/db/app";
import {
  approvalDecided,
  contentPipelineRequested,
  contextSignalsScanRequested,
  inngest,
  opportunitiesScanRequested,
  siteHealthCheckRequested,
  sitePreflightRequested,
} from "@/lib/inngest";
import { loadApproval, recordDecision } from "@/lib/pipeline/approvals";
import { loadOpportunity, markOpportunity } from "@/lib/pipeline/opportunities";
import { createPreflight } from "@/lib/proxy/store";
import { createOrganization, createSite, createSiteSchema, loadSite, setSiteStatus, SiteInputError } from "./store";

/**
 * Server actions behind the dashboard forms. Each one re-checks the session
 * and the caller's role for the org it touches, then writes through the
 * service connection or sends the Inngest event that does the work.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}

export async function createOrgAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return fail("Give the organisation a name.");
  const org = await createOrganization(user.id, name);
  revalidatePath("/app");
  return { ok: true, id: org.id };
}

export async function createSiteAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = createSiteSchema.safeParse({
    orgId: form.get("orgId"),
    name: form.get("name"),
    domain: form.get("domain"),
    pathPrefix: form.get("pathPrefix") || "/resources",
    proxyMode: form.get("proxyMode") || "cloudflare_worker",
    organizationName: form.get("organizationName") || undefined,
  });
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (!canManage(user, parsed.data.orgId)) return fail("Only owners and admins can add projects.");
  let siteId: string;
  try {
    siteId = (await createSite(user.id, parsed.data)).id;
  } catch (e) {
    if (e instanceof SiteInputError) return fail(e.message);
    throw e;
  }
  revalidatePath("/app");
  redirect(`/app/sites/${siteId}` as Route);
}

async function siteForAction(siteId: string, need: "edit" | "manage") {
  const user = await requireUser();
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Project not found." };
  const allowed = need === "manage" ? canManage(user, site.org_id) : canEdit(user, site.org_id);
  return { user, site, error: allowed ? null : "You do not have access to this project." };
}

export async function runPreflightAction(siteId: string, kind: "preflight" | "crawler_report"): Promise<ActionResult> {
  const { site, error } = await siteForAction(siteId, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  const { id } = await createPreflight(siteId, kind);
  await inngest.send(sitePreflightRequested.create({ siteId, orgId: site.org_id, kind, preflightId: id }));
  revalidatePath(`/app/sites/${siteId}`);
  return { ok: true, id };
}

export async function runHealthCheckAction(siteId: string, kind: "monitor" | "verification"): Promise<ActionResult> {
  const { site, error } = await siteForAction(siteId, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  await inngest.send(siteHealthCheckRequested.create({ siteId, orgId: site.org_id, kind }));
  revalidatePath(`/app/sites/${siteId}`);
  return { ok: true };
}

export async function scanOpportunitiesAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await siteForAction(siteId, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  await inngest.send([opportunitiesScanRequested.create({ siteId, orgId: site.org_id }), contextSignalsScanRequested.create({ siteId, orgId: site.org_id })]);
  revalidatePath(`/app/sites/${siteId}`);
  return { ok: true };
}

export async function startPipelineAction(opportunityId: string, note?: string): Promise<ActionResult> {
  const opp = await loadOpportunity(opportunityId);
  if (!opp) return fail("Opportunity not found.");
  const { site, error } = await siteForAction(opp.site_id, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  if (opp.status !== "open") return fail(`Opportunity is already ${opp.status}.`);
  await markOpportunity(opportunityId, "queued");
  await inngest.send(contentPipelineRequested.create({ opportunityId, siteId: opp.site_id, orgId: opp.org_id, note: note?.trim() || null }));
  revalidatePath(`/app/sites/${opp.site_id}`);
  return { ok: true };
}

export async function dismissOpportunityAction(opportunityId: string): Promise<ActionResult> {
  const opp = await loadOpportunity(opportunityId);
  if (!opp) return fail("Opportunity not found.");
  const { site, error } = await siteForAction(opp.site_id, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  await markOpportunity(opportunityId, "dismissed", appDb(), "dismissed in app");
  revalidatePath(`/app/sites/${opp.site_id}`);
  return { ok: true };
}

export async function decideApprovalAction(approvalId: string, decision: "approve" | "changes" | "regenerate", note?: string): Promise<ActionResult> {
  const approval = await loadApproval(approvalId);
  if (!approval) return fail("Approval not found.");
  const { user, site, error } = await siteForAction(approval.site_id, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  const by = { userId: user.id, name: user.name ?? user.email };
  const { applied } = await recordDecision(approvalId, { decision, by, source: "app", note: note?.trim() || null });
  if (!applied) return fail("This approval was already decided.");
  await inngest.send(approvalDecided.create({ approvalId, decision, by, source: "app", note: note?.trim() || null, orgId: approval.org_id }));
  revalidatePath(`/app/sites/${approval.site_id}`);
  return { ok: true };
}

export async function setSiteStatusAction(siteId: string, status: "paused" | "active" | "disabled"): Promise<ActionResult> {
  const { user, site, error } = await siteForAction(siteId, "manage");
  if (!site) return fail(error!);
  if (error) return fail(error);
  await setSiteStatus(siteId, site.org_id, status, user.id);
  revalidatePath(`/app/sites/${siteId}`);
  revalidatePath("/ops");
  return { ok: true };
}

// ── staff only ──────────────────────────────────────────────────────────────

export async function setFeatureAction(orgId: string, feature: string, enabled: boolean): Promise<ActionResult> {
  await requireStaff();
  await setFeature(orgId, feature, enabled);
  revalidatePath("/ops");
  return { ok: true };
}

export async function addStaffBootstrapAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const staff = await requireStaff();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter an email address.");
  const sql = appDb();
  await sql`insert into app.staff_bootstrap (email, level) values (${email}, 'admin') on conflict (email) do nothing`;
  // Promote immediately when the person already has an account.
  await sql`insert into app.internal_staff (user_id, level) select id, 'admin' from app.users where lower(email) = ${email} on conflict do nothing`;
  await sql`insert into app.audit_log (actor_user_id, action, target_type, target_id) values (${staff.id}, 'staff.add', 'staff', ${email})`;
  revalidatePath("/ops");
  return { ok: true };
}
