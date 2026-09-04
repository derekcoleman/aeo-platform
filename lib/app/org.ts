import type postgres from "postgres";
import type { OrgRole } from "@/lib/auth/roles";
import { appDb } from "@/lib/db/app";

/**
 * Organisation admin read models and the membership rules the actions
 * enforce. Roles: owner > admin > editor > viewer. Staff are not members.
 */

export interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  plan: string;
  plan_status: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_email: string | null;
  retention_days: number;
  serp_monthly_budget_usd: number;
  trial_ends_at: string | Date;
  created_at: string | Date;
}

export async function loadOrg(orgId: string, sql: postgres.Sql = appDb()): Promise<OrgDetail | null> {
  const [row] = await sql<OrgDetail[]>`
    select id, name, slug, plan, plan_status, status, stripe_customer_id, stripe_subscription_id, billing_email,
           retention_days, serp_monthly_budget_usd::float as serp_monthly_budget_usd, trial_ends_at, created_at
    from app.organizations where id = ${orgId}`;
  return row ?? null;
}

export interface MemberRow {
  user_id: string;
  email: string;
  name: string | null;
  role: OrgRole;
  created_at: string | Date;
}

export async function listMembers(orgId: string, sql: postgres.Sql = appDb()): Promise<MemberRow[]> {
  return sql<MemberRow[]>`
    select m.user_id, u.email, u.name, m.role, m.created_at
    from app.memberships m join app.users u on u.id = m.user_id
    where m.org_id = ${orgId}
    order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, u.email`;
}

export interface InviteRow {
  id: string;
  email: string;
  role: OrgRole;
  expires_at: string | Date;
  created_at: string | Date;
  invited_by_email: string | null;
}

export async function listInvites(orgId: string, sql: postgres.Sql = appDb()): Promise<InviteRow[]> {
  return sql<InviteRow[]>`
    select i.id, i.email, i.role, i.expires_at, i.created_at, u.email as invited_by_email
    from app.org_invites i left join app.users u on u.id = i.invited_by
    where i.org_id = ${orgId} and i.accepted_at is null and i.expires_at > now()
    order by i.created_at desc`;
}

/** Pending invites for this email become memberships. Called on every sign-in; idempotent. */
export async function acceptInvitesFor(userId: string, email: string | null | undefined, sql: postgres.Sql = appDb()): Promise<number> {
  if (!email) return 0;
  const rows = await sql<{ id: string; org_id: string; role: OrgRole }[]>`
    update app.org_invites set accepted_at = now()
    where lower(email) = lower(${email}) and accepted_at is null and expires_at > now()
    returning id, org_id, role`;
  for (const r of rows) {
    await sql`insert into app.memberships (user_id, org_id, role) values (${userId}, ${r.org_id}, ${r.role}) on conflict (user_id, org_id) do nothing`;
    await sql`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
      values (${r.org_id}, ${userId}, 'member.join', 'membership', ${userId}, ${sql.json({ via: "invite", role: r.role } as never)})`;
  }
  return rows.length;
}

export const ASSIGNABLE_ROLES: OrgRole[] = ["admin", "editor", "viewer"];

/** Owners manage everyone; admins manage editors and viewers and may not create or touch owners or other admins. */
export function canAssignRole(actor: OrgRole, current: OrgRole | null, next: OrgRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return (current === null || current === "editor" || current === "viewer") && (next === "editor" || next === "viewer");
  return false;
}

export function wouldRemoveLastOwner(members: Pick<MemberRow, "user_id" | "role">[], userId: string, next: OrgRole | null): boolean {
  const owners = members.filter((m) => m.role === "owner");
  const target = members.find((m) => m.user_id === userId);
  if (!target || target.role !== "owner") return false;
  return owners.length <= 1 && next !== "owner";
}

export interface AuditRow {
  id: number;
  org_id: string | null;
  org_name: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  after: Record<string, unknown> | null;
  at: string | Date;
}

export async function auditLog(orgId: string | null, limit = 100, sql: postgres.Sql = appDb()): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select a.id, a.org_id, o.name as org_name, u.email as actor_email, a.action, a.target_type, a.target_id, a.after, a.at
    from app.audit_log a
    left join app.organizations o on o.id = a.org_id
    left join app.users u on u.id = a.actor_user_id
    where (${orgId}::uuid is null or a.org_id = ${orgId}::uuid)
    order by a.at desc limit ${limit}`;
}
