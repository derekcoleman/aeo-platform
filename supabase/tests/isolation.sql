-- ============================================================================
-- Tenant isolation regression test.
--
-- Run against a database with 0001 applied:
--   psql -f supabase/tests/isolation.sql -d <db>
--
-- Every assertion here protects a decision that is expensive to get wrong.
-- If any of these start failing, stop and fix the policy — do not adjust the
-- expectation. Case 4 in particular: a claim we cannot parse must DENY.
-- ============================================================================
\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

-- ── fixtures ────────────────────────────────────────────────────────────────
insert into app.organizations (id, name, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Acme',   'acme'),
  ('22222222-2222-2222-2222-222222222222', 'Globex', 'globex')
on conflict do nothing;

insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Acme', 'acme.com', '/resources', 'acme-8fj2.blogedge.aeo.app'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'Globex', 'globex.com', '/blog', 'globex-2k9x.blogedge.aeo.app')
on conflict do nothing;

insert into content.published_pages (site_id, path, html, etag) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '/resources/hello', '<h1>Acme</h1>',   'e1'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '/blog/hello',      '<h1>Globex</h1>', 'e2')
on conflict do nothing;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;
grant usage on schema app, content to app_user;
grant select on all tables in schema app, content to app_user;

-- ── assertions ──────────────────────────────────────────────────────────────
-- Each runs in its own transaction: SET LOCAL is a silent no-op outside one,
-- which would make every check pass as superuser and prove nothing.
create or replace function pg_temp.expect(label text, got bigint, want bigint)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL % — expected %, got %', label, want, got;
  end if;
  raise notice 'ok  %', label;
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees only own org sites',
    (select count(*) from app.sites), 1);
  select pg_temp.expect('member sees own published page',
    (select count(*) from content.published_pages
      where site_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1);
  select pg_temp.expect('member cannot see other org published page',
    (select count(*) from content.published_pages
      where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0);
commit;

begin;
  set local role app_user;
  select pg_temp.expect('absent claims deny', (select count(*) from app.sites), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":"not-an-array"}';
  select pg_temp.expect('malformed claim denies', (select count(*) from app.sites), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees all orgs', (select count(*) from app.sites), 2);
commit;

begin;
  set local role renderer;
  select pg_temp.expect('renderer reads published_pages',
    (select count(*) from content.published_pages), 2);
commit;

-- The renderer must be unable to reach anything but its one table. We assert
-- the failure explicitly so a future GRANT that widens it breaks the build.
begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from app.sites;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read app.sites';
    end if;
    raise notice 'ok  renderer cannot read app.sites';
  end $$;
commit;

\echo 'isolation: all assertions passed'

-- ── 0002: render config materialisation ─────────────────────────────────────
begin;
  select pg_temp.expect('render config materialised on site insert',
    (select count(*) from content.site_render_config
      where site_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1);
commit;

begin;
  update app.sites set path_prefix = '/guides'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select pg_temp.expect('render config follows a site update',
    (select count(*) from content.site_render_config
      where site_id = 'aaaaaaaa-0000-0000-0000-000000000001' and path_prefix = '/guides'), 1);
rollback;

begin;
  set local role renderer;
  select pg_temp.expect('renderer reads render config',
    (select count(*) from content.site_render_config), 2);
commit;

-- A site must not be able to claim our internal rewrite target as its prefix.
do $$
declare blocked boolean := false;
begin
  begin
    update app.sites set path_prefix = '/render'
      where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL a site must not claim the reserved /render prefix';
  end if;
  raise notice 'ok  reserved prefix rejected';
end $$;

\echo 'render config: all assertions passed'
