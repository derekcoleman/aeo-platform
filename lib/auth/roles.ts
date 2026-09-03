/** Pure role helpers, kept apart from session.ts so they are testable without next/headers. */

export type OrgRole = "owner" | "admin" | "editor" | "viewer";

export interface Membership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
}

export function staffEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.AEO_STAFF_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** The caller's role in an org, or null. Staff count as admin everywhere. */
export function roleIn(user: { isStaff: boolean; memberships: Membership[] }, orgId: string): OrgRole | null {
  const m = user.memberships.find((x) => x.orgId === orgId);
  if (m) return m.role;
  return user.isStaff ? "admin" : null;
}

export function canManage(user: { isStaff: boolean; memberships: Membership[] }, orgId: string): boolean {
  const r = roleIn(user, orgId);
  return r === "owner" || r === "admin";
}

export function canEdit(user: { isStaff: boolean; memberships: Membership[] }, orgId: string): boolean {
  const r = roleIn(user, orgId);
  return r === "owner" || r === "admin" || r === "editor";
}

/** Org ids the caller may read: their memberships, or everything for staff. */
export function visibleOrgIds(user: { isStaff: boolean; memberships: Membership[] }): string[] | "all" {
  return user.isStaff ? "all" : user.memberships.map((m) => m.orgId);
}
