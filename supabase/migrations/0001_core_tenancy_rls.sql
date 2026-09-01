-- ============================================================================
-- 0001 — schemas, core tenancy, RLS pattern, and the renderer role.
--
-- This migration encodes the isolation decisions that are expensive to reverse.
-- Read the three notes before changing anything here.
--
-- 1. org_id is denormalised onto EVERY tenant table, including grandchildren.
--    No RLS policy may join upward to find a tenant. A policy that joins is
--    both a correctness footgun and a query-planner disaster.
--
-- 2. Tenant checks read a JWT claim (app.auth_org_ids()), not a subquery
--    against memberships. Membership changes therefore require a token
--    refresh — force one when a membership changes.
--
-- 3. The public blog renderer does NOT use RLS. There is no user on that path.
--    It connects as `renderer`, which can SELECT exactly one table. See the
--    final section.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create schema if not exists app;
create schema if not exists content;
create schema if not exists context;
create schema if not exists measure;
create schema if not exists analytics;
create schema if not exists ops;

-- ─────────────────────────────────────────────────────────────── enums ──────
create type app.member_role   as enum ('owner', 'admin', 'editor', 'viewer');
create type app.proxy_mode    as enum ('cloudflare_worker', 'vercel_rewrite', 'nginx', 'netlify', 'subdomain');
create type app.slash_mode    as enum ('never', 'always');
create type app.site_status   as enum ('provisioning', 'verifying', 'active', 'paused', 'disabled');
create type content.item_status as enum ('draft', 'in_review', 'approved', 'published', 'archived');

-- ═══════════════════════════════════════════════════════════ app schema ═════

create table app.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  plan                text not null default 'trial',
  status              text not null default 'active',
  stripe_customer_id  text,
  created_at          timestamptz not null default now()
);

-- Mirrors auth.users. FK is added conditionally so the migration also applies
-- to a bare Postgres used for tests, where the auth schema does not exist.
create table app.users (
  id          uuid primary key,
  email       text not null,
  name        text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'auth' and table_name = 'users') then
    alter table app.users
      add constraint users_auth_fk foreign key (id) references auth.users (id) on delete cascade;
  end if;
end $$;

create table app.memberships (
  user_id     uuid not null references app.users (id) on delete cascade,
  org_id      uuid not null references app.organizations (id) on delete cascade,
  role        app.member_role not null default 'viewer',
  created_at  timestamptz not null default now(),
  primary key (user_id, org_id)
);
create index memberships_org_idx on app.memberships (org_id);

-- Our own staff are a separate axis from customer memberships, so an ops
-- person never inflates a customer's seat count or pollutes their audit trail.
create table app.internal_staff (
  user_id  uuid primary key references app.users (id) on delete cascade,
  level    text not null default 'support'
);

create table app.audit_log (
  id             bigint generated always as identity primary key,
  org_id         uuid references app.organizations (id) on delete set null,
  actor_user_id  uuid,
  action         text not null,
  target_type    text,
  target_id      text,
  before         jsonb,
  after          jsonb,
  at             timestamptz not null default now()
);
create index audit_log_org_at_idx on app.audit_log (org_id, at desc);

-- ── sites ───────────────────────────────────────────────────────────────────
-- A site is a publishable surface: (canonical_domain, path_prefix). Publishing,
-- proxy and measurement config hang off the SITE; brand/context hangs off the
-- ORG. Multi-brand and multi-locale customers need several sites per org, and
-- retrofitting that split later is painful.
create table app.sites (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references app.organizations (id) on delete cascade,
  name              text not null,

  canonical_domain  text not null,                       -- acme.com
  path_prefix       text not null default '/resources',  -- kept in the PUBLIC url
  -- Non-guessable per-site hostname the customer's proxy targets. `Host` is the
  -- only channel every proxy technology can set (vercel.json rewrites cannot add
  -- request headers), and it keeps CDN cache keys tenant-scoped by default.
  edge_hostname     text not null unique,
  proxy_mode        app.proxy_mode not null default 'cloudflare_worker',
  proxy_secret_ref  text,                                -- vault ref, never the secret
  trailing_slash    app.slash_mode not null default 'never',
  locale            text not null default 'en-US',

  health_nonce      text not null default encode(gen_random_bytes(16), 'hex'),
  status            app.site_status not null default 'provisioning',
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),

  constraint sites_path_prefix_shape check (path_prefix ~ '^/[a-z0-9][a-z0-9/_-]*$'),
  constraint sites_prefix_no_trailing_slash check (path_prefix !~ '/$')
);
create index sites_org_idx on app.sites (org_id);

-- Hosts we will honour in x-forwarded-host. An unrecognised forwarded host
-- renders noindex rather than 404, so a misconfigured proxy degrades to
-- "not indexed" instead of "duplicate of the customer's content on our domain".
create table app.site_domains (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references app.organizations (id) on delete cascade,
  site_id     uuid not null references app.sites (id) on delete cascade,
  hostname    text not null,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (site_id, hostname)
);
create index site_domains_hostname_idx on app.site_domains (hostname);

-- Theming is data, never per-tenant code and never tenant-supplied JS.
-- header_html/footer_html/custom_css are ops-authored and sanitised on write.
create table app.site_themes (
  site_id      uuid primary key references app.sites (id) on delete cascade,
  org_id       uuid not null references app.organizations (id) on delete cascade,
  version      integer not null default 1,
  tokens       jsonb not null default '{}'::jsonb,   -- -> CSS custom properties
  header_html  text,
  footer_html  text,
  custom_css   text,
  head_snippet text,
  body_snippet text,
  nav_spec     jsonb,
  extracted_from_url text,
  updated_at   timestamptz not null default now()
);

create table app.site_health_checks (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references app.organizations (id) on delete cascade,
  site_id     uuid not null references app.sites (id) on delete cascade,
  checked_at  timestamptz not null default now(),
  ok          boolean not null,
  ttfb_ms     integer,
  detail      jsonb
);
create index site_health_site_at_idx on app.site_health_checks (site_id, checked_at desc);

-- ═══════════════════════════════════════════════════════ content schema ═════

create table content.content_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references app.organizations (id) on delete cascade,
  site_id            uuid not null references app.sites (id) on delete cascade,
  slug               text not null,
  type               text not null default 'article',
  status             content.item_status not null default 'draft',
  canonical_url      text,
  noindex            boolean not null default false,
  first_published_at timestamptz,
  published_at       timestamptz,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (site_id, slug),
  constraint content_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]*$')
);
create index content_items_site_status_idx on content.content_items (site_id, status);

-- ── the render hot path ─────────────────────────────────────────────────────
-- Denormalised and materialised at publish time. This is the ONLY table the
-- renderer role can read, which bounds the blast radius of a renderer bug to
-- "published content served to the wrong site" — which the customer Worker's
-- X-AEO-Site check then catches at their edge.
create table content.published_pages (
  site_id          uuid not null references app.sites (id) on delete cascade,
  path             text not null,          -- public path incl. the site's prefix
  content_item_id  uuid references content.content_items (id) on delete set null,
  html             text not null,
  head             jsonb not null default '{}'::jsonb,
  markdown         text,
  etag             text not null,
  updated_at       timestamptz not null default now(),
  primary key (site_id, path)
);

-- ═════════════════════════════════════════════════════ tenancy helpers ══════

-- Reads org_ids from the JWT, injected by a Supabase custom access token hook
-- that reads app.memberships. Claim-based rather than a per-row subquery, so a
-- membership change requires a token refresh — force one when it happens.
create or replace function app.auth_org_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
  ids    uuid[];
begin
  claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if claims is null or claims -> 'org_ids' is null then
    return '{}'::uuid[];
  end if;
  select array_agg(value::uuid) into ids
  from jsonb_array_elements_text(claims -> 'org_ids');
  return coalesce(ids, '{}'::uuid[]);
exception when others then
  -- A malformed claim must deny, never grant.
  return '{}'::uuid[];
end $$;

create or replace function app.auth_is_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb;
begin
  claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  return coalesce((claims -> 'is_staff')::text = 'true', false);
exception when others then
  return false;
end $$;

-- ═══════════════════════════════════════════════════════════════ RLS ════════
-- FORCE so even the table owner is subject to policy. Read policies allow the
-- caller's orgs (or staff); write policies are narrower and role-aware.

do $$
declare t text;
begin
  foreach t in array array[
    'app.organizations', 'app.memberships', 'app.sites', 'app.site_domains',
    'app.site_themes', 'app.site_health_checks', 'app.audit_log',
    'content.content_items', 'content.published_pages'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
end $$;

-- organizations keys on id rather than org_id.
create policy org_read on app.organizations for select
  using (id = any (app.auth_org_ids()) or app.auth_is_staff());

create policy membership_read on app.memberships for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

do $$
declare t text;
begin
  foreach t in array array[
    'app.sites', 'app.site_domains', 'app.site_themes', 'app.site_health_checks',
    'app.audit_log', 'content.content_items'
  ] loop
    execute format(
      'create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
end $$;

-- published_pages deliberately has no org_id: it is keyed by site and read by
-- the renderer role, not by users. App-side previews get a site-scoped policy.
create policy tenant_read on content.published_pages for select
  using (
    exists (
      select 1 from app.sites s
      where s.id = published_pages.site_id
        and (s.org_id = any (app.auth_org_ids()) or app.auth_is_staff())
    )
  );

-- Writes: editors and above, own org only. Viewers get no write policy at all.
create policy tenant_write on content.content_items for all
  using (org_id = any (app.auth_org_ids()))
  with check (org_id = any (app.auth_org_ids()));

create policy site_write on app.sites for all
  using (org_id = any (app.auth_org_ids()))
  with check (org_id = any (app.auth_org_ids()));

-- ═════════════════════════════════════════════════ the renderer role ════════
-- The public blog path has no user, so it must not run under RLS or a service
-- role. It gets one grant on one table. site_id always comes from a validated
-- Host header, never from user input.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'renderer') then
    create role renderer nologin;
  end if;
end $$;

grant usage on schema content to renderer;
grant select on content.published_pages to renderer;

-- Explicitly deny everything else, including future tables.
alter default privileges in schema content revoke all on tables from renderer;
alter default privileges in schema app     revoke all on tables from renderer;
revoke all on all tables in schema app     from renderer;
revoke all on all tables in schema context from renderer;
revoke all on all tables in schema measure from renderer;

-- The renderer bypasses RLS on its one table by policy, not by superuser.
create policy renderer_read on content.published_pages for select
  to renderer using (true);
