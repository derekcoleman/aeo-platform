-- ============================================================================
-- 0009 — App plane: auth mirror, JWT claims hook, staff bootstrap, org writes.
--
-- app.users mirrors auth.users so memberships and audit rows can reference a
-- stable id without granting the app schema access to auth.*. On Supabase the
-- mirror is kept by a trigger on auth.users; on a bare Postgres (tests) the
-- functions exist but nothing fires them.
--
-- app.custom_access_token_hook is the Supabase Auth "custom access token"
-- hook (enable it in Dashboard → Authentication → Hooks). It injects
-- `org_ids` and `is_staff` into every JWT, which is what app.auth_org_ids()
-- and app.auth_is_staff() read — claim-based RLS, no per-row subquery. A
-- membership change requires a token refresh; the app forces one.
--
-- Staff is a table (app.internal_staff) plus a bootstrap: emails listed in
-- app.staff_bootstrap are promoted on first sign-in, so the first operator
-- never has to hand-edit a row to reach /ops.
-- ============================================================================

-- The caller's user id from the JWT `sub` claim. Same posture as
-- app.auth_org_ids(): a claim we cannot parse yields null, which denies.
create or replace function app.auth_uid()
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  return nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
exception when others then
  return null;
end $$;

create table app.staff_bootstrap (
  email       text primary key,
  level       text not null default 'admin',
  created_at  timestamptz not null default now()
);

create or replace function app.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into app.users (id, email, name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(excluded.name, app.users.name),
        avatar_url = coalesce(excluded.avatar_url, app.users.avatar_url);
  -- First operator bootstrap: a listed email becomes staff on first sign-in.
  if new.email is not null and exists (select 1 from app.staff_bootstrap b where lower(b.email) = lower(new.email)) then
    insert into app.internal_staff (user_id, level)
    select new.id, b.level from app.staff_bootstrap b where lower(b.email) = lower(new.email)
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created after insert or update of email, raw_user_meta_data on auth.users for each row execute function app.handle_new_auth_user()';
  end if;
end $$;

-- The JWT claims hook. Signature is fixed by Supabase Auth: jsonb in, jsonb out.
create or replace function app.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  claims  jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  uid     uuid  := (event ->> 'user_id')::uuid;
  org_ids jsonb;
  staff   boolean;
begin
  select coalesce(jsonb_agg(m.org_id), '[]'::jsonb) into org_ids from app.memberships m where m.user_id = uid;
  select exists (select 1 from app.internal_staff s where s.user_id = uid) into staff;
  claims := jsonb_set(claims, '{org_ids}', org_ids, true);
  claims := jsonb_set(claims, '{is_staff}', to_jsonb(staff), true);
  return jsonb_set(event, '{claims}', claims, true);
end $$;

-- Supabase Auth runs the hook as supabase_auth_admin; grant only what it needs.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema app to supabase_auth_admin';
    execute 'grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin';
    execute 'revoke execute on function app.custom_access_token_hook(jsonb) from authenticated, anon, public';
    execute 'grant select on app.memberships, app.internal_staff to supabase_auth_admin';
  end if;
end $$;

-- Members see who else is in their org; owners/admins manage memberships.
create policy membership_write on app.memberships for all
  using (org_id = any (app.auth_org_ids()) and exists (
    select 1 from app.memberships me where me.org_id = memberships.org_id and me.user_id = app.auth_uid() and me.role in ('owner', 'admin')))
  with check (org_id = any (app.auth_org_ids()));

-- Users may read their own mirror row; staff read all.
alter table app.users enable row level security;
alter table app.users force row level security;
create policy users_self_read on app.users for select using (id = app.auth_uid() or app.auth_is_staff());
alter table app.internal_staff enable row level security;
alter table app.internal_staff force row level security;
create policy staff_self_read on app.internal_staff for select using (user_id = app.auth_uid() or app.auth_is_staff());
alter table app.staff_bootstrap enable row level security;
alter table app.staff_bootstrap force row level security;
create policy staff_bootstrap_staff_read on app.staff_bootstrap for select using (app.auth_is_staff());

-- Owners and admins can edit their organisation (name, plan is staff-only in practice).
create policy org_write on app.organizations for update
  using (id = any (app.auth_org_ids()) and exists (
    select 1 from app.memberships me where me.org_id = organizations.id and me.user_id = app.auth_uid() and me.role in ('owner', 'admin')))
  with check (id = any (app.auth_org_ids()));

-- Feature flags are curated by staff; members read them (policy exists from 0005).
create policy staff_write on app.org_features for all using (app.auth_is_staff()) with check (app.auth_is_staff());

revoke all on all tables in schema app from renderer;
