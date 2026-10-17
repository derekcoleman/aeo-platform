"use server";

import { dispatch, queueJob } from "@/lib/jobs/dispatch";
import { runSiteOnboarding } from "@/lib/onboarding/run";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Route } from "next";
import { canEdit, canManage, requireStaff, requireUser } from "@/lib/auth/session";
import { answerProbesConfigured, sitesForAnswerProbes } from "@/lib/answers/sample";
import { setFeature } from "@/lib/connectors/store";
import { appDb } from "@/lib/db/app";
import {
  approvalDecided,
  contentPipelineRequested,
  contentRemediateFaqRequested,
  contextSignalsScanRequested,
  inngest,
  metricsRestatementRequested,
  answersSampleRequested,
  opportunitiesScanRequested,
  siteHealthCheckRequested,
  sitePreflightRequested,
  siteOnboardingRequested,
} from "@/lib/inngest";
import { loadApproval, recordDecision } from "@/lib/pipeline/approvals";
import { setBudgetCap } from "@/lib/ops/spend";
import { BUDGET_CAP_MAX_USD } from "@/lib/ops/spend-limits";
import { dismissOpportunity, loadOpportunity, markOpportunity, PERSON_DISMISS_REASONS, type DismissReason } from "@/lib/pipeline/opportunities";
import { createPreflight } from "@/lib/proxy/store";
import { createOrganization, createSite, createSiteSchema, deleteSite, loadSite, setSiteStatus, SiteInputError } from "./store";
import { vaultSecrets } from "@/lib/secrets/vault";

/**
 * Server actions behind the dashboard forms. Each one re-checks the session
 * and the caller's role for the org it touches, then writes through the
 * service connection or sends the Inngest event that does the work.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** Extra outcome shown next to the success label (what else was started, what was skipped). */
  note?: string;
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
    keywords: form.get("keywords") || undefined,
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
  const site = await loadSite(siteId);
  if (site) {
    await dispatch(
      () => inngest.send(siteOnboardingRequested.create({ siteId, orgId: site.org_id })),
      () => runSiteOnboarding({ siteId, orgId: site.org_id }),
      "site onboarding",
    );
  }
  revalidatePath("/app");
  redirect(`/app/sites/${siteId}` as Route);
}

/**
 * Delete a project. Owners and admins only, and the caller must type the
 * project's domain: this removes published pages, content, topics, prompts,
 * connectors and telemetry for the project in one go.
 */
export async function deleteSiteAction(siteId: string, confirmation: string): Promise<ActionResult> {
  const { user, site, error } = await siteForAction(siteId, "manage");
  if (!site) return fail(error ?? "Project not found.");
  if (error) return fail(error);
  if (confirmation.trim().toLowerCase() !== site.canonical_domain.toLowerCase()) return fail(`Type ${site.canonical_domain} to confirm.`);
  await deleteSite(site, user.id, vaultSecrets());
  revalidatePath("/app");
  redirect("/app" as Route);
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
  const jobError = await queueJob(sitePreflightRequested.create({ siteId, orgId: site.org_id, kind, preflightId: id }));
  if (jobError) return fail(jobError);
  revalidatePath(`/app/sites/${siteId}`);
  return { ok: true, id };
}

export async function runHealthCheckAction(siteId: string, kind: "monitor" | "verification"): Promise<ActionResult> {
  const { site, error } = await siteForAction(siteId, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  const jobError = await queueJob(siteHealthCheckRequested.create({ siteId, orgId: site.org_id, kind }));
  if (jobError) return fail(jobError);
  revalidatePath(`/app/sites/${siteId}`);
  return { ok: true };
}

export async function scanOpportunitiesAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await siteForAction(siteId, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  const jobError = await queueJob([opportunitiesScanRequested.create({ siteId, orgId: site.org_id }), contextSignalsScanRequested.create({ siteId, orgId: site.org_id })]);
  if (jobError) return fail(jobError);
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
  const jobError = await queueJob(contentPipelineRequested.create({ opportunityId, siteId: opp.site_id, orgId: opp.org_id, note: note?.trim() || null }));
  if (jobError) return fail(jobError);
  revalidatePath(`/app/sites/${opp.site_id}`);
  return { ok: true };
}

/** Dismiss from the queue with a reason a person picks (the pipeline's own reasons are not theirs to give). */
export async function dismissOpportunityAction(opportunityId: string, reason: string = "other"): Promise<ActionResult> {
  const picked = PERSON_DISMISS_REASONS.find((r) => r.value === reason);
  if (!picked) return fail("Pick a reason.");
  const opp = await loadOpportunity(opportunityId);
  if (!opp) return fail("Opportunity not found.");
  const { user, site, error } = await siteForAction(opp.site_id, "edit");
  if (!site) return fail(error!);
  if (error) return fail(error);
  const { applied } = await dismissOpportunity(opportunityId, picked.value as DismissReason, `dismissed in app by ${user.name ?? user.email}: ${picked.label.toLowerCase()}`, appDb());
  if (!applied) return fail(`Opportunity is already ${opp.status}.`);
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
  const jobError = await queueJob(approvalDecided.create({ approvalId, decision, by, source: "app", note: note?.trim() || null, orgId: approval.org_id }), undefined, "pipeline resume");
  revalidatePath(`/app/sites/${approval.site_id}`);
  if (jobError) return fail(`Decision saved, but the pipeline could not resume. ${jobError}`);
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

// A cleared field is an error, not a $0 cap that would stop every call.
const budgetCapForm = z.object({ budgetId: z.guid(), capUsd: z.string().trim().regex(/^\d+(\.\d+)?$/).transform(Number).refine((n) => n <= BUDGET_CAP_MAX_USD) });

/**
 * Set one spend budget's cap (Ops → Spend). The org-wide monthly SERP cap is
 * written to the org's own setting, within the limit its settings form
 * allows; audited either way.
 */
export async function setBudgetCapAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const staff = await requireStaff();
  const parsed = budgetCapForm.safeParse({ budgetId: form.get("budgetId"), capUsd: form.get("capUsd") });
  if (!parsed.success) return fail(`Enter a cap between 0 and ${BUDGET_CAP_MAX_USD} USD.`);
  const changed = await setBudgetCap(parsed.data.budgetId, parsed.data.capUsd, staff.id);
  if (!changed.ok) return fail(changed.error);
  revalidatePath("/ops");
  return { ok: true };
}

/** Republish live pages that print their FAQ twice (one site, or every site). The job writes the audit row with the paths. */
export async function remediateFaqAction(siteId: string | null): Promise<ActionResult> {
  const staff = await requireStaff();
  const jobError = await queueJob(contentRemediateFaqRequested.create({ siteId, requestedBy: staff.id }), undefined, "FAQ remediation");
  if (jobError) return fail(jobError);
  return { ok: true };
}

/** Restate the headline numbers under the current methodology (one site, or every measured site). The job writes the audit rows. */
export async function restateMetricsAction(siteId: string | null): Promise<ActionResult> {
  const staff = await requireStaff();
  const jobError = await queueJob(metricsRestatementRequested.create({ siteId, requestedBy: staff.id }), undefined, "metrics restatement");
  if (jobError) return fail(jobError);
  return { ok: true };
}

/** Sample answers now for every eligible site of the org (staff, from /ops), instead of waiting for Tuesday. */
export async function sampleAnswersAction(orgId: string): Promise<ActionResult> {
  const staff = await requireStaff();
  if (!answerProbesConfigured()) return fail("No OpenRouter key is configured: answer probes go through OpenRouter only.");
  const sites = await sitesForAnswerProbes(orgId);
  if (sites.length === 0) return fail("Nothing to sample: answer probes are off for this organisation, or none of its active projects tracks a prompt.");
  const jobError = await queueJob(sites.map((s) => answersSampleRequested.create({ siteId: s.site_id, orgId: s.org_id, requestedBy: staff.id })), undefined, "answer sampling");
  if (jobError) return fail(jobError);
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
