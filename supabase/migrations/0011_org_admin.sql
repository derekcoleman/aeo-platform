-- ============================================================================
-- 0011 — Org admin: invites, billing state, retention.
--
-- app.org_invites         an email invited to an org with a role; accepted on
--                         the invitee's first sign-in with that email (the
--                         token link is a convenience, the email is the key).
-- app.organizations       + retention_days (context purge window), Stripe
--                         subscription state, billing email.
-- ============================================================================

create table app.org_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references app.organizations (id) on delete cascade,
  email        text not null,
  role         app.member_role not null default 'editor',
  token        text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by   uuid references app.users (id) on delete set null,
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint org_invites_email_shape check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint org_invites_role_not_owner check (role <> 'owner')
);
create unique index org_invites_pending_idx on app.org_invites (org_id, lower(email)) where accepted_at is null;
create index org_invites_email_idx on app.org_invites (lower(email)) where accepted_at is null;

alter table app.organizations
  add column retention_days          int not null default 365 check (retention_days between 30 and 3650),
  add column stripe_subscription_id  text,
  add column plan_status             text not null default 'trialing' check (plan_status in ('trialing', 'active', 'past_due', 'canceled', 'paused')),
  add column billing_email           text,
  add column trial_ends_at           timestamptz not null default now() + interval '14 days';

comment on column app.organizations.retention_days is
  'Ingested context (documents, chunks) older than this is purged nightly; verified facts and published content are kept.';

-- ── Org-admin predicate ────────────────────────────────────────────────────
-- 0009's membership_write and org_write policies subqueried app.memberships
-- from inside a policy ON app.memberships, which Postgres rejects as infinite
-- recursion the moment a member selects from it. A security-definer function
-- reads memberships outside RLS; every "is this caller an owner or admin of
-- that org" check goes through it from here on.
create or replace function app.auth_is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.memberships m
    where m.org_id = p_org and m.user_id = app.auth_uid() and m.role in ('owner', 'admin'));
$$;
revoke all on function app.auth_is_org_admin(uuid) from public;
grant execute on function app.auth_is_org_admin(uuid) to public;

drop policy if exists membership_write on app.memberships;
create policy membership_write on app.memberships for all
  using (app.auth_is_org_admin(org_id))
  with check (org_id = any (app.auth_org_ids()) and app.auth_is_org_admin(org_id));

drop policy if exists org_write on app.organizations;
create policy org_write on app.organizations for update
  using (app.auth_is_org_admin(id))
  with check (id = any (app.auth_org_ids()));

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table app.org_invites enable row level security;
alter table app.org_invites force row level security;
create policy tenant_read on app.org_invites for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());
create policy invites_insert on app.org_invites for insert
  with check (app.auth_is_org_admin(org_id));
create policy invites_update on app.org_invites for update
  using (app.auth_is_org_admin(org_id)) with check (app.auth_is_org_admin(org_id));
create policy invites_delete on app.org_invites for delete
  using (app.auth_is_org_admin(org_id));

revoke all on app.org_invites from renderer;
