"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { z } from "zod";
import { requireUser, roleIn } from "@/lib/auth/session";
import { createCheckoutSession, createPortalSession, planSpec, stripeConfigured } from "@/lib/billing/stripe";
import { appDb } from "@/lib/db/app";
import { sendEmail, textToHtml } from "@/lib/notify/email";
import type { ActionResult } from "./actions";
import { canAssignRole, listMembers, loadOrg, wouldRemoveLastOwner } from "./org";

/**
 * Organisation admin actions: members, invites, settings, billing. The role
 * rules live in lib/app/org.ts so they are testable; every write is audited.
 */

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(orgId: string, level: "admin" | "owner") {
  const user = await requireUser(`/app/orgs/${orgId}`);
  const role = roleIn(user, orgId);
  const ok = role === "owner" || (level === "admin" && role === "admin");
  return { user, role, error: ok ? null : "Only organisation owners" + (level === "admin" ? " and admins" : "") + " can do this." };
}

async function audit(orgId: string, actorId: string, action: string, targetType: string, targetId: string, after: Record<string, unknown>) {
  await appDb()`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
    values (${orgId}, ${actorId}, ${action}, ${targetType}, ${targetId}, ${appDb().json(after as never)})`;
}

const refresh = (orgId: string) => revalidatePath(`/app/orgs/${orgId}`);

const inviteForm = z.object({ orgId: z.guid(), email: z.string().trim().email().max(200), role: z.enum(["admin", "editor", "viewer"]) });

export async function inviteMemberAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = inviteForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail("Enter a valid email and role.");
  const { orgId, email, role } = parsed.data;
  const { user, role: actorRole, error } = await guard(orgId, "admin");
  if (error || !actorRole) return fail(error ?? "Forbidden");
  if (!canAssignRole(actorRole, null, role)) return fail("Admins can invite editors and viewers only.");
  const org = await loadOrg(orgId);
  if (!org) return fail("Organisation not found.");
  const [existing] = await appDb()<{ user_id: string }[]>`select m.user_id from app.memberships m join app.users u on u.id = m.user_id where m.org_id = ${orgId} and lower(u.email) = lower(${email})`;
  if (existing) return fail("That person is already a member.");
  const [invite] = await appDb()<{ id: string; token: string }[]>`
    insert into app.org_invites (org_id, email, role, invited_by) values (${orgId}, ${email}, ${role}, ${user.id})
    on conflict (org_id, lower(email)) where accepted_at is null do update set role = excluded.role, expires_at = now() + interval '14 days', invited_by = excluded.invited_by
    returning id, token`;
  if (!invite) return fail("Could not create the invite.");
  await audit(orgId, user.id, "member.invite", "org_invite", invite.id, { email, role });
  const appUrl = process.env.APP_URL;
  const text = [
    `${user.name ?? user.email ?? "A teammate"} invited you to ${org.name} on AEO Platform as ${role}.`,
    appUrl ? `Sign in with this email address to accept: ${appUrl}/login?next=${encodeURIComponent("/app")}` : "Sign in with this email address to accept.",
    "The invite expires in 14 days.",
  ].join("\n\n");
  const sent = await sendEmail({ to: [email], subject: `You're invited to ${org.name} on AEO Platform`, text, html: textToHtml(text) });
  refresh(orgId);
  return { ok: true, id: invite.id, error: sent.sent ? undefined : `Invite saved; email not sent (${sent.reason}). They can sign in with ${email} to accept.` };
}

export async function revokeInviteAction(orgId: string, inviteId: string): Promise<ActionResult> {
  const { user, error } = await guard(orgId, "admin");
  if (error) return fail(error);
  await appDb()`delete from app.org_invites where id = ${inviteId} and org_id = ${orgId} and accepted_at is null`;
  await audit(orgId, user.id, "member.invite.revoke", "org_invite", inviteId, {});
  refresh(orgId);
  return { ok: true };
}

export async function setMemberRoleAction(orgId: string, userId: string, next: "owner" | "admin" | "editor" | "viewer"): Promise<ActionResult> {
  const { user, role: actorRole, error } = await guard(orgId, "admin");
  if (error || !actorRole) return fail(error ?? "Forbidden");
  const members = await listMembers(orgId);
  const target = members.find((m) => m.user_id === userId);
  if (!target) return fail("Not a member.");
  if (!canAssignRole(actorRole, target.role, next)) return fail("You cannot assign that role.");
  if (wouldRemoveLastOwner(members, userId, next)) return fail("An organisation needs at least one owner.");
  await appDb()`update app.memberships set role = ${next} where org_id = ${orgId} and user_id = ${userId}`;
  await audit(orgId, user.id, "member.role", "membership", userId, { from: target.role, to: next });
  refresh(orgId);
  return { ok: true };
}

export async function removeMemberAction(orgId: string, userId: string): Promise<ActionResult> {
  const { user, role: actorRole, error } = await guard(orgId, "admin");
  if (error || !actorRole) return fail(error ?? "Forbidden");
  const members = await listMembers(orgId);
  const target = members.find((m) => m.user_id === userId);
  if (!target) return fail("Not a member.");
  if (!canAssignRole(actorRole, target.role, "viewer")) return fail("You cannot remove that member.");
  if (wouldRemoveLastOwner(members, userId, null)) return fail("An organisation needs at least one owner.");
  await appDb()`delete from app.memberships where org_id = ${orgId} and user_id = ${userId}`;
  await audit(orgId, user.id, "member.remove", "membership", userId, { role: target.role });
  refresh(orgId);
  return { ok: true };
}

const settingsForm = z.object({
  orgId: z.guid(),
  name: z.string().trim().min(2).max(120),
  retentionDays: z.coerce.number().int().min(30).max(3650),
  billingEmail: z.string().trim().email().max(200).or(z.literal("")),
  serpBudget: z.coerce.number().min(0).max(5000),
});

export async function updateOrgSettingsAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = settingsForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid settings.");
  const { orgId, name, retentionDays, billingEmail, serpBudget } = parsed.data;
  const { user, error } = await guard(orgId, "owner");
  if (error) return fail(error);
  const before = await loadOrg(orgId);
  if (!before) return fail("Organisation not found.");
  const budget = user.isStaff ? serpBudget : Math.min(serpBudget, 500);
  await appDb()`update app.organizations set name = ${name}, retention_days = ${retentionDays}, billing_email = ${billingEmail || null}, serp_monthly_budget_usd = ${budget} where id = ${orgId}`;
  await audit(orgId, user.id, "org.settings", "organization", orgId, { name, retentionDays, billingEmail: billingEmail || null, serpBudget: budget, before: { name: before.name, retentionDays: before.retention_days, serpBudget: before.serp_monthly_budget_usd } });
  refresh(orgId);
  revalidatePath("/app");
  return { ok: true };
}

export async function startCheckoutAction(orgId: string, plan: string): Promise<ActionResult> {
  const { user, error } = await guard(orgId, "owner");
  if (error) return fail(error);
  if (!stripeConfigured()) return fail("Billing is not configured yet (STRIPE_SECRET_KEY).");
  const spec = planSpec(plan);
  if (!spec) return fail("Unknown plan.");
  const org = await loadOrg(orgId);
  if (!org) return fail("Organisation not found.");
  const base = process.env.APP_URL ?? "";
  let url: string;
  try {
    ({ url } = await createCheckoutSession({ orgId, plan: spec.key, customerEmail: org.billing_email ?? user.email, customerId: org.stripe_customer_id, successUrl: `${base}/app/orgs/${orgId}?checkout=success`, cancelUrl: `${base}/app/orgs/${orgId}?checkout=cancel` }));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  await audit(orgId, user.id, "billing.checkout.start", "organization", orgId, { plan: spec.key });
  redirect(url as Route);
}

export async function openPortalAction(orgId: string): Promise<ActionResult> {
  const { error } = await guard(orgId, "owner");
  if (error) return fail(error);
  if (!stripeConfigured()) return fail("Billing is not configured yet.");
  const org = await loadOrg(orgId);
  if (!org?.stripe_customer_id) return fail("No billing account yet; choose a plan first.");
  let url: string;
  try {
    ({ url } = await createPortalSession(org.stripe_customer_id, `${process.env.APP_URL ?? ""}/app/orgs/${orgId}`));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  redirect(url as Route);
}
