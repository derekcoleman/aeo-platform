import type { Route } from "next";
import { redirect } from "next/navigation";
import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { staffEmails, type Membership } from "./roles";
import { supabaseServer } from "./supabase";

export { canEdit, canManage, roleIn, visibleOrgIds } from "./roles";

/**
 * Who is asking, and what may they see. The app plane runs its queries on
 * the service connection AFTER checking the session and membership here, so
 * every page scopes by the memberships this returns — RLS stays defence in
 * depth for direct client access. Staff (app.internal_staff, or an email in
 * AEO_STAFF_EMAILS as a bootstrap) may read every org and use /ops.
 */

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  isStaff: boolean;
  memberships: Membership[];
}

export async function currentUser(sql: postgres.Sql = appDb()): Promise<SessionUser | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  if (!u) return null;
  // Mirror lazily too, in case the auth trigger is not installed (bare Postgres, or the hook not yet enabled).
  await sql`
    insert into app.users (id, email, name, avatar_url)
    values (${u.id}, ${u.email ?? ""}, ${(u.user_metadata?.full_name as string | undefined) ?? (u.user_metadata?.name as string | undefined) ?? null}, ${(u.user_metadata?.avatar_url as string | undefined) ?? null})
    on conflict (id) do update set email = excluded.email, name = coalesce(excluded.name, app.users.name)`;
  const [staffRow] = await sql<{ level: string }[]>`select level from app.internal_staff where user_id = ${u.id}`;
  const bootstrap = !!u.email && staffEmails().has(u.email.toLowerCase());
  if (!staffRow && bootstrap) await sql`insert into app.internal_staff (user_id, level) values (${u.id}, 'admin') on conflict do nothing`;
  const memberships = await sql<{ org_id: string; name: string; slug: string; role: Membership["role"] }[]>`
    select m.org_id, o.name, o.slug, m.role from app.memberships m join app.organizations o on o.id = m.org_id
    where m.user_id = ${u.id} order by o.name`;
  return {
    id: u.id,
    email: u.email ?? null,
    name: (u.user_metadata?.full_name as string | undefined) ?? (u.user_metadata?.name as string | undefined) ?? null,
    isStaff: !!staffRow || bootstrap,
    memberships: memberships.map((m) => ({ orgId: m.org_id, orgName: m.name, orgSlug: m.slug, role: m.role })),
  };
}

export async function requireUser(next = "/app"): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}` as Route);
  return user;
}

export async function requireStaff(): Promise<SessionUser> {
  const user = await requireUser("/ops");
  if (!user.isStaff) redirect("/app?denied=ops" as Route);
  return user;
}
