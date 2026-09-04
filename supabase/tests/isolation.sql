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

-- ── 0003: audit runs ────────────────────────────────────────────────────────
insert into app.audit_runs (id, org_id, target_url, domain, kind, status) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'https://acme.com', 'acme.com', 'monitored', 'completed'),
  ('cccccccc-0000-0000-0000-000000000002', null,
   'https://example.com', 'example.com', 'public', 'completed')
on conflict do nothing;
insert into app.audit_findings (audit_run_id, rule_key, category, priority) values
  ('cccccccc-0000-0000-0000-000000000001', 'crawler.gptbot_blocked', 'crawler_access', 'critical'),
  ('cccccccc-0000-0000-0000-000000000002', 'crawler.gptbot_blocked', 'crawler_access', 'critical');
insert into app.public_audits (id, audit_run_id, domain) values
  ('abc12345', 'cccccccc-0000-0000-0000-000000000002', 'example.com')
on conflict do nothing;
grant select on all tables in schema app to app_user;

begin;
  select pg_temp.expect('finding org_id denormalised from run',
    (select count(*) from app.audit_findings
      where audit_run_id = 'cccccccc-0000-0000-0000-000000000001'
        and org_id = '11111111-1111-1111-1111-111111111111'), 1);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees own audit runs', (select count(*) from app.audit_runs), 1);
  select pg_temp.expect('member sees own findings', (select count(*) from app.audit_findings), 1);
  select pg_temp.expect('member cannot see public (null-org) audits via RLS',
    (select count(*) from app.audit_runs where org_id is null), 0);
  select pg_temp.expect('member cannot enumerate share links',
    (select count(*) from app.public_audits), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees all audit runs', (select count(*) from app.audit_runs), 2);
commit;

\echo 'isolation: audit assertions passed'

-- ── 0004: demand mining + SERP tracking ─────────────────────────────────────
insert into measure.questions (id, site_id, text, normalized, source, seed_term, locale, device, demand_score, is_tracked, tracking_tier) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'What is SCIM provisioning?', 'what is scim provisioning', 'autocomplete', 'scim', 'us-en', 'desktop', 12, true, 'weekly'),
  ('dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002',
   'Globex vs Initech pricing', 'globex vs initech pricing', 'paa', 'globex', 'us-en', 'desktop', 9, false, 'none')
on conflict do nothing;
insert into measure.serp_snapshots (id, site_id, question_id, provider, fetched_at, locale, device, aio_triggered, cost_usd) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000001', 'serpapi', now(), 'us-en', 'desktop', true, 0.02)
on conflict do nothing;
insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001',
   'ai_overview', 'https://competitor.com/scim', 'competitor.com', 1, false);
insert into measure.serp_cache (key, provider, method, query, locale, device, day, payload) values
  ('serpapi|serp|us-en|desktop|2026-01-01|what is scim provisioning', 'serpapi', 'serp',
   'what is scim provisioning', 'us-en', 'desktop', '2026-01-01', '{}'::jsonb)
on conflict do nothing;
grant usage on schema measure to app_user;
grant select on all tables in schema measure to app_user;

begin;
  select pg_temp.expect('question org_id denormalised from site',
    (select count(*) from measure.questions
      where id = 'dddddddd-0000-0000-0000-000000000001'
        and org_id = '11111111-1111-1111-1111-111111111111'), 1);
  select pg_temp.expect('snapshot org_id denormalised from site',
    (select count(*) from measure.serp_snapshots
      where id = 'eeeeeeee-0000-0000-0000-000000000001'
        and org_id = '11111111-1111-1111-1111-111111111111'), 1);
  select pg_temp.expect('citation org_id denormalised from site',
    (select count(*) from measure.serp_citations
      where serp_snapshot_id = 'eeeeeeee-0000-0000-0000-000000000001'
        and org_id = '11111111-1111-1111-1111-111111111111'), 1);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees only own questions', (select count(*) from measure.questions), 1);
  select pg_temp.expect('member cannot see other org questions',
    (select count(*) from measure.questions where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0);
  select pg_temp.expect('member sees own snapshots', (select count(*) from measure.serp_snapshots), 1);
  select pg_temp.expect('member sees own citations', (select count(*) from measure.serp_citations), 1);
  select pg_temp.expect('member cannot read the shared serp cache', (select count(*) from measure.serp_cache), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('other member sees only their questions',
    (select count(*) from measure.questions where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 1);
  select pg_temp.expect('other member sees no Acme citations', (select count(*) from measure.serp_citations), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees all questions', (select count(*) from measure.questions), 2);
  select pg_temp.expect('staff reads the serp cache', (select count(*) from measure.serp_cache), 1);
commit;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from measure.questions;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read measure.questions';
    end if;
    raise notice 'ok  renderer cannot read measure.questions';
  end $$;
commit;

\echo 'isolation: demand/serp assertions passed'

-- ── 0005: connectors ────────────────────────────────────────────────────────
insert into app.org_features (org_id, feature, enabled) values
  ('11111111-1111-1111-1111-111111111111', 'connector:profound', true)
on conflict do nothing;
insert into context.context_connections (id, org_id, site_id, provider, status, config, scope, secret_ref, external_account_id, external_account_name) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', null,
   'slack', 'active', '{"teamId":"T123","channels":[]}'::jsonb, '[]'::jsonb, 'vault:connection:cccccccc-0000-0000-0000-000000000001', 'T123', 'Acme HQ'),
  ('cccccccc-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002',
   'google', 'pending', '{}'::jsonb, '[]'::jsonb, null, 'ops@globex.com', 'ops@globex.com')
on conflict do nothing;
-- org_id deliberately omitted: the trigger must denormalise it from the connection.
insert into context.context_sync_runs (id, connection_id, kind, status, documents_ingested) values
  ('cccccccc-1000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'backfill', 'succeeded', 1)
on conflict do nothing;
insert into context.context_documents (connection_id, provider, kind, external_id, text, content_sha256) values
  ('cccccccc-0000-0000-0000-000000000001', 'slack', 'slack_message', 'C1:1700000000.000100', 'we shipped SCIM', repeat('a', 64))
on conflict do nothing;
insert into ops.webhook_events (provider, external_id, payload) values
  ('slack', 'Ev0001', '{"type":"event_callback"}'::jsonb)
on conflict do nothing;
grant usage on schema context, ops to app_user;
grant select on all tables in schema context, ops to app_user;

select pg_temp.expect('sync run org_id denormalised from connection',
  (select count(*) from context.context_sync_runs where id = 'cccccccc-1000-0000-0000-000000000001'
     and org_id = '11111111-1111-1111-1111-111111111111'), 1);
select pg_temp.expect('document org_id denormalised from connection',
  (select count(*) from context.context_documents where connection_id = 'cccccccc-0000-0000-0000-000000000001'
     and org_id = '11111111-1111-1111-1111-111111111111'), 1);

do $$
declare rejected boolean := false;
begin
  begin
    insert into context.context_connections (org_id, provider, secret_ref)
    values ('11111111-1111-1111-1111-111111111111', 'slack', 'xoxb-1234-5678-abcdef');
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL raw token accepted as secret_ref';
  end if;
  raise notice 'ok  raw token rejected as secret_ref';
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees own connections only', (select count(*) from context.context_connections), 1);
  select pg_temp.expect('member sees no Globex connection',
    (select count(*) from context.context_connections where org_id = '22222222-2222-2222-2222-222222222222'), 0);
  select pg_temp.expect('member sees own sync runs', (select count(*) from context.context_sync_runs), 1);
  select pg_temp.expect('member sees own documents', (select count(*) from context.context_documents), 1);
  select pg_temp.expect('member sees own feature flags', (select count(*) from app.org_features), 1);
  select pg_temp.expect('member cannot read the webhook ledger', (select count(*) from ops.webhook_events), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('other member sees only their connection',
    (select count(*) from context.context_connections where org_id = '22222222-2222-2222-2222-222222222222'), 1);
  select pg_temp.expect('other member sees no Acme sync runs', (select count(*) from context.context_sync_runs), 0);
  select pg_temp.expect('other member sees no Acme documents', (select count(*) from context.context_documents), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees all connections', (select count(*) from context.context_connections), 2);
  select pg_temp.expect('staff reads the webhook ledger', (select count(*) from ops.webhook_events), 1);
commit;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from context.context_connections;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read context.context_connections';
    end if;
    raise notice 'ok  renderer cannot read context.context_connections';
  end $$;
commit;

\echo 'isolation: connector assertions passed'

-- ── 0006: pipeline ──────────────────────────────────────────────────────────
-- org_id deliberately omitted on every child row: the before-insert triggers
-- must denormalise it from the site / item / version.
insert into content.authors (id, site_id, name, job_title, is_default) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Jane Acme', 'Head of Product', true),
  ('dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Gus Globex', null, true)
on conflict do nothing;
insert into content.opportunities (id, site_id, source, title, target_query, dedupe_key, score) values
  ('dddddddd-1000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'citation_gap',
   'okta vs entra for mid-market', 'okta vs entra for mid-market', 'q:okta-vs-entra', 72.5),
  ('dddddddd-1000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'manual',
   'globex widgets', 'globex widgets', 'q:globex-widgets', 10)
on conflict do nothing;
insert into content.briefs (id, site_id, opportunity_id, spec, target_answer) values
  ('dddddddd-2000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-1000-0000-0000-000000000001',
   '{"headQuestion":"okta vs entra for mid-market"}'::jsonb, 'Okta and Entra both cover SSO; the difference is directory ownership.')
on conflict do nothing;
insert into content.content_items (id, org_id, site_id, slug, title, brief_id, author_id, opportunity_id) values
  ('dddddddd-3000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'okta-vs-entra', 'Okta vs Entra for mid-market', 'dddddddd-2000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000001', 'dddddddd-1000-0000-0000-000000000001'),
  ('dddddddd-3000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002',
   'globex-widgets', 'Globex widgets', null, 'dddddddd-0000-0000-0000-000000000002', null)
on conflict do nothing;
insert into content.content_versions (id, content_item_id, version_no, title, body_md, body_html, word_count) values
  ('dddddddd-4000-0000-0000-000000000001', 'dddddddd-3000-0000-0000-000000000001', 1, 'Okta vs Entra', '# Okta vs Entra', '<h1>Okta vs Entra</h1>', 3),
  ('dddddddd-4000-0000-0000-000000000002', 'dddddddd-3000-0000-0000-000000000002', 1, 'Globex widgets', '# Widgets', '<h1>Widgets</h1>', 1)
on conflict do nothing;
update content.content_items set current_version_id = 'dddddddd-4000-0000-0000-000000000001' where id = 'dddddddd-3000-0000-0000-000000000001';
insert into content.content_sources (content_version_id, key, url, publisher, quote) values
  ('dddddddd-4000-0000-0000-000000000001', 'gartner-2026', 'https://www.gartner.com/x', 'Gartner', '61% of mid-market buyers')
on conflict do nothing;
insert into content.qa_results (content_version_id, gate, passed, detail) values
  ('dddddddd-4000-0000-0000-000000000001', 'structure', true, '{"normalized":0.8}'::jsonb)
on conflict do nothing;
insert into content.approvals (id, site_id, kind, brief_id, expires_at) values
  ('dddddddd-5000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'brief', 'dddddddd-2000-0000-0000-000000000001', now() + interval '7 days')
on conflict do nothing;
insert into ops.llm_calls (org_id, site_id, task_key, model, input_tokens, output_tokens, cost_usd) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'pipeline.brief', 'test-model', 10, 20, 0.001);
grant select on all tables in schema content, ops to app_user;

select pg_temp.expect('author org_id denormalised from site',
  (select count(*) from content.authors where id = 'dddddddd-0000-0000-0000-000000000001'
     and org_id = '11111111-1111-1111-1111-111111111111'), 1);
select pg_temp.expect('opportunity org_id denormalised from site',
  (select count(*) from content.opportunities where id = 'dddddddd-1000-0000-0000-000000000002'
     and org_id = '22222222-2222-2222-2222-222222222222'), 1);
select pg_temp.expect('brief org_id denormalised from site',
  (select count(*) from content.briefs where id = 'dddddddd-2000-0000-0000-000000000001'
     and org_id = '11111111-1111-1111-1111-111111111111'), 1);
select pg_temp.expect('version org_id denormalised from item',
  (select count(*) from content.content_versions where id = 'dddddddd-4000-0000-0000-000000000002'
     and org_id = '22222222-2222-2222-2222-222222222222'), 1);
select pg_temp.expect('source org_id denormalised from version',
  (select count(*) from content.content_sources where org_id = '11111111-1111-1111-1111-111111111111'), 1);
select pg_temp.expect('qa result org_id denormalised from version',
  (select count(*) from content.qa_results where org_id = '11111111-1111-1111-1111-111111111111'), 1);
select pg_temp.expect('approval org_id denormalised from site',
  (select count(*) from content.approvals where id = 'dddddddd-5000-0000-0000-000000000001'
     and org_id = '11111111-1111-1111-1111-111111111111'), 1);

do $$
declare rejected boolean := false;
begin
  begin
    insert into content.approvals (site_id, kind, brief_id, content_version_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'draft', 'dddddddd-2000-0000-0000-000000000001', null);
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL draft approval accepted without a content version';
  end if;
  raise notice 'ok  approval target shape enforced';
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees own authors only', (select count(*) from content.authors), 1);
  select pg_temp.expect('member sees own opportunities only', (select count(*) from content.opportunities), 1);
  select pg_temp.expect('member sees own briefs', (select count(*) from content.briefs), 1);
  select pg_temp.expect('member sees own versions only', (select count(*) from content.content_versions), 1);
  select pg_temp.expect('member sees own sources', (select count(*) from content.content_sources), 1);
  select pg_temp.expect('member sees own qa results', (select count(*) from content.qa_results), 1);
  select pg_temp.expect('member sees own approvals', (select count(*) from content.approvals), 1);
  select pg_temp.expect('member cannot read the llm ledger', (select count(*) from ops.llm_calls), 0);
  select pg_temp.expect('member sees no Globex version',
    (select count(*) from content.content_versions where org_id = '22222222-2222-2222-2222-222222222222'), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('other member sees only their author', (select count(*) from content.authors), 1);
  select pg_temp.expect('other member sees only their opportunity',
    (select count(*) from content.opportunities where org_id = '22222222-2222-2222-2222-222222222222'), 1);
  select pg_temp.expect('other member sees no Acme briefs', (select count(*) from content.briefs), 0);
  select pg_temp.expect('other member sees no Acme sources', (select count(*) from content.content_sources), 0);
  select pg_temp.expect('other member sees no Acme approvals', (select count(*) from content.approvals), 0);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees all opportunities', (select count(*) from content.opportunities), 2);
  select pg_temp.expect('staff sees all versions', (select count(*) from content.content_versions), 2);
  select pg_temp.expect('staff reads the llm ledger', (select count(*) from ops.llm_calls), 1);
commit;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from content.content_versions;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read content.content_versions';
    end if;
    raise notice 'ok  renderer cannot read content.content_versions';
  end $$;
  select pg_temp.expect('renderer still reads published_pages',
    (select count(*) from content.published_pages), 2);
commit;

\echo 'isolation: pipeline assertions passed'

-- ── 0007: brand brain ───────────────────────────────────────────────────────
-- Globex needs a document of its own so cross-org chunk counts mean something.
insert into context.context_documents (id, connection_id, provider, kind, external_id, text, content_sha256) values
  ('eeeeeeee-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'google', 'gsc_note', 'globex:doc:1', 'globex widgets ship weekly', repeat('b', 64))
on conflict do nothing;
-- org_id deliberately omitted on chunks and content_facts: the triggers must
-- denormalise it from the document / the version.
insert into context.context_chunks (id, document_id, ordinal, text, token_estimate, embedding, embedding_model) values
  ('eeeeeeee-1000-0000-0000-000000000001',
   (select id from context.context_documents where external_id = 'C1:1700000000.000100'), 0, 'we shipped SCIM', 4,
   ('[' || repeat('0,', 1535) || '1]')::vector, 'hash-bow'),
  ('eeeeeeee-1000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000002', 0, 'globex widgets ship weekly', 5, null, null)
on conflict do nothing;
insert into context.entities (id, org_id, type, name, aliases) values
  ('eeeeeeee-2000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'brand', 'Acme', '{"acme.com"}'),
  ('eeeeeeee-2000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'competitor', 'Okta', '{}'),
  ('eeeeeeee-2000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'brand', 'Globex', '{}')
on conflict do nothing;
insert into context.brand_facts (id, org_id, site_id, type, subject_entity_id, subject_text, predicate, object_text, status, visibility, verified_at, dedupe_key) values
  ('eeeeeeee-3000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'product_capability', 'eeeeeeee-2000-0000-0000-000000000001', 'Acme', 'supports', 'SCIM provisioning on every plan', 'verified', 'public', now(),
   'product_capability|acme|supports'),
  ('eeeeeeee-3000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', null,
   'objection', 'eeeeeeee-2000-0000-0000-000000000001', 'Acme', 'buyers ask about', 'SOC 2 status', 'candidate', 'internal', null,
   'objection|acme|buyers-ask-about'),
  ('eeeeeeee-3000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', null,
   'positioning', 'eeeeeeee-2000-0000-0000-000000000003', 'Globex', 'is', 'the widget company', 'verified', 'public', now(),
   'positioning|globex|is')
on conflict do nothing;
insert into context.brand_manifests (id, org_id, site_id, version, status, doc, activated_at) values
  ('eeeeeeee-4000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', null, 1, 'active', '{"brand":{"name":"Acme"}}'::jsonb, now()),
  ('eeeeeeee-4000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', null, 1, 'draft', '{"brand":{"name":"Globex"}}'::jsonb, null)
on conflict do nothing;
insert into context.signals (id, org_id, site_id, kind, title, evidence, score) values
  ('eeeeeeee-5000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'term_spike', 'scim', '{"n7":9,"n30":12}'::jsonb, 42),
  ('eeeeeeee-5000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002', 'unanswered_question', 'how fast do widgets ship', '{}'::jsonb, 30)
on conflict do nothing;
update content.opportunities set signal_id = 'eeeeeeee-5000-0000-0000-000000000001' where id = 'dddddddd-1000-0000-0000-000000000001';
update content.briefs set manifest_version_id = 'eeeeeeee-4000-0000-0000-000000000001' where id = 'dddddddd-2000-0000-0000-000000000001';
insert into content.content_facts (content_version_id, key, fact_id, text) values
  ('dddddddd-4000-0000-0000-000000000001', 'product-capability-supports-eeee', 'eeeeeeee-3000-0000-0000-000000000001', 'Acme supports SCIM provisioning on every plan'),
  ('dddddddd-4000-0000-0000-000000000002', 'positioning-is-eeee', 'eeeeeeee-3000-0000-0000-000000000003', 'Globex is the widget company')
on conflict do nothing;
grant select on all tables in schema context, content to app_user;
grant update on context.brand_facts to app_user;

select pg_temp.expect('chunk org_id denormalised from document',
  (select count(*) from context.context_chunks where id = 'eeeeeeee-1000-0000-0000-000000000002'
     and org_id = '22222222-2222-2222-2222-222222222222'), 1);
select pg_temp.expect('content fact org_id denormalised from version',
  (select count(*) from content.content_facts where org_id = '11111111-1111-1111-1111-111111111111'), 1);
select pg_temp.expect('chunk tsvector is generated with the english config',
  (select count(*) from context.context_chunks where tsv @@ to_tsquery('english', 'ship') and org_id = '22222222-2222-2222-2222-222222222222'), 1);
select pg_temp.expect('serp_citations.entity_id is a real FK now',
  (select count(*) from pg_constraint where conname = 'serp_citations_entity_fk'), 1);
select pg_temp.expect('opportunity → signal lineage',
  (select count(*) from content.opportunities o join context.signals s on s.id = o.signal_id where o.id = 'dddddddd-1000-0000-0000-000000000001'), 1);

do $$
declare rejected boolean := false;
begin
  begin
    insert into context.brand_facts (org_id, type, subject_text, predicate, object_text, status, verified_at, dedupe_key)
    values ('11111111-1111-1111-1111-111111111111', 'product_capability', 'Acme', 'supports', 'SCIM again', 'verified', now(), 'product_capability|acme|supports');
  exception when unique_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL second verified fact accepted for the same dedupe key';
  end if;
  raise notice 'ok  one verified fact per (org, dedupe_key)';
end $$;

do $$
declare rejected boolean := false;
begin
  begin
    insert into context.brand_manifests (org_id, site_id, version, status, doc, activated_at)
    values ('11111111-1111-1111-1111-111111111111', null, 2, 'active', '{}'::jsonb, now());
  exception when unique_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL second active org-wide manifest accepted';
  end if;
  raise notice 'ok  one active manifest per org/site';
end $$;

do $$
declare rejected boolean := false;
begin
  begin
    insert into context.context_chunks (document_id, ordinal, text, embedding)
    values ('eeeeeeee-0000-0000-0000-000000000002', 9, 'no model', ('[' || repeat('0,', 1535) || '1]')::vector);
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'FAIL embedding accepted without embedding_model';
  end if;
  raise notice 'ok  embedding and embedding_model travel together';
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees own chunks only',        (select count(*) from context.context_chunks), 1);
  select pg_temp.expect('member sees own entities only',      (select count(*) from context.entities), 2);
  select pg_temp.expect('member sees own facts only',         (select count(*) from context.brand_facts), 2);
  select pg_temp.expect('member sees own manifests only',     (select count(*) from context.brand_manifests), 1);
  select pg_temp.expect('member sees own signals only',       (select count(*) from context.signals), 1);
  select pg_temp.expect('member sees own content facts only', (select count(*) from content.content_facts), 1);
  select pg_temp.expect('member cannot see the other org''s verified fact',
    (select count(*) from context.brand_facts where id = 'eeeeeeee-3000-0000-0000-000000000003'), 0);
  -- tenant_write: a member can verify their own candidate, not another org's.
  update context.brand_facts set status = 'verified', verified_at = now() where id = 'eeeeeeee-3000-0000-0000-000000000002';
  select pg_temp.expect('member verified own candidate fact',
    (select count(*) from context.brand_facts where id = 'eeeeeeee-3000-0000-0000-000000000002' and status = 'verified'), 1);
  update context.brand_facts set status = 'rejected' where id = 'eeeeeeee-3000-0000-0000-000000000003';
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('other member sees only its own chunks',   (select count(*) from context.context_chunks), 1);
  select pg_temp.expect('other member sees only its own facts',    (select count(*) from context.brand_facts), 1);
  select pg_temp.expect('other member sees only its own signals',  (select count(*) from context.signals), 1);
  do $$
  declare n int;
  begin
    update context.brand_facts set status = 'rejected' where id = 'eeeeeeee-3000-0000-0000-000000000001';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'FAIL other member updated an Acme fact';
    end if;
    raise notice 'ok  other member cannot touch Acme facts';
  end $$;
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every chunk',    (select count(*) from context.context_chunks), 2);
  select pg_temp.expect('staff sees every fact',     (select count(*) from context.brand_facts), 3);
  select pg_temp.expect('staff sees every manifest', (select count(*) from context.brand_manifests), 2);
commit;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform count(*) from context.context_chunks;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer can read context.context_chunks';
    end if;
    begin
      denied := false;
      perform count(*) from context.brand_facts;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer can read context.brand_facts';
    end if;
    raise notice 'ok  renderer cannot read the brand brain';
  end $$;
commit;

\echo 'isolation: brand brain assertions passed'

-- ── 0008: site ops ──────────────────────────────────────────────────────────
-- org_id deliberately omitted: the trigger must denormalise it from the site.
insert into app.site_preflights (id, site_id, kind, status, ok, result) values
  ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'preflight', 'completed', true, '{"blocking":[]}'::jsonb),
  ('ffffffff-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'crawler_report', 'completed', false, '{}'::jsonb)
on conflict do nothing;
insert into app.site_health_checks (org_id, site_id, kind, ok, ttfb_ms, failed) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'monitor', false, 812, '{"health_endpoint"}'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002', 'verification', true, 120, '{}');
update app.sites set health_failures = 2, last_health_ok = false where id = 'aaaaaaaa-0000-0000-0000-000000000001';
grant select on all tables in schema app to app_user;

select pg_temp.expect('preflight org_id denormalised from site',
  (select count(*) from app.site_preflights where id = 'ffffffff-0000-0000-0000-000000000002'
     and org_id = '22222222-2222-2222-2222-222222222222'), 1);
select pg_temp.expect('failed health checks are indexable by site',
  (select count(*) from app.site_health_checks where site_id = 'aaaaaaaa-0000-0000-0000-000000000001' and not ok and 'health_endpoint' = any(failed)), 1);

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member sees own preflights only',    (select count(*) from app.site_preflights), 1);
  select pg_temp.expect('member sees own health checks only', (select count(*) from app.site_health_checks), 1);
  select pg_temp.expect('member sees own site health state',
    (select count(*) from app.sites where id = 'aaaaaaaa-0000-0000-0000-000000000001' and health_failures = 2 and last_health_ok = false), 1);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('other member cannot see Acme preflights',
    (select count(*) from app.site_preflights where id = 'ffffffff-0000-0000-0000-000000000001'), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every preflight', (select count(*) from app.site_preflights), 2);
commit;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from app.site_preflights;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read app.site_preflights';
    end if;
    raise notice 'ok  renderer cannot read preflights';
  end $$;
commit;

\echo 'isolation: site ops assertions passed'

-- ── 0009: app auth ──────────────────────────────────────────────────────────
insert into app.users (id, email, name) values
  ('99999999-0000-0000-0000-000000000001', 'jane@acme.com', 'Jane Acme'),
  ('99999999-0000-0000-0000-000000000002', 'ops@aeo.app', 'Ops')
on conflict do nothing;
insert into app.memberships (user_id, org_id, role) values
  ('99999999-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner')
on conflict do nothing;
insert into app.internal_staff (user_id, level) values ('99999999-0000-0000-0000-000000000002', 'admin') on conflict do nothing;
insert into app.staff_bootstrap (email) values ('founder@aeo.app') on conflict do nothing;
grant select on all tables in schema app to app_user;

-- The JWT hook injects org_ids and is_staff from memberships / internal_staff.
select pg_temp.expect('access token hook lists the member''s orgs',
  (select jsonb_array_length((app.custom_access_token_hook(jsonb_build_object('user_id', '99999999-0000-0000-0000-000000000001', 'claims', '{}'::jsonb)) -> 'claims' -> 'org_ids'))), 1);
select pg_temp.expect('access token hook marks staff',
  (select count(*) from (select 1 where (app.custom_access_token_hook(jsonb_build_object('user_id', '99999999-0000-0000-0000-000000000002', 'claims', '{}'::jsonb)) -> 'claims' ->> 'is_staff') = 'true') x), 1);
select pg_temp.expect('access token hook marks a non-staff member false',
  (select count(*) from (select 1 where (app.custom_access_token_hook(jsonb_build_object('user_id', '99999999-0000-0000-0000-000000000001', 'claims', '{}'::jsonb)) -> 'claims' ->> 'is_staff') = 'false') x), 1);

begin;
  set local role app_user;
  set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-000000000001","org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('user reads own mirror row only', (select count(*) from app.users), 1);
  select pg_temp.expect('member cannot read the staff table for others', (select count(*) from app.internal_staff), 0);
  select pg_temp.expect('member cannot read staff bootstrap', (select count(*) from app.staff_bootstrap), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-000000000002","org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff reads every user', (select count(*) from app.users), 2);
  select pg_temp.expect('staff reads bootstrap', (select count(*) from app.staff_bootstrap), 1);
commit;

begin;
  set local role app_user;
  set local request.jwt.claims = 'not json';
  select pg_temp.expect('malformed claims deny the users table', (select count(*) from app.users), 0);
rollback;

\echo 'isolation: app auth assertions passed'

-- ── 0010: crawl telemetry ───────────────────────────────────────────────────
grant usage on schema analytics to app_user;
grant select on all tables in schema analytics, ops to app_user;
grant select on all tables in schema app to app_user;

-- org_id omitted everywhere: the site trigger must fill it.
insert into analytics.crawl_events (site_id, ts, path, bot_family, purpose, verified, source) values
  ('aaaaaaaa-0000-0000-0000-000000000001', now(), '/resources/sso-vs-scim', 'chatgpt-user', 'live_fetch', true, 'worker'),
  ('aaaaaaaa-0000-0000-0000-000000000001', now(), '/resources/sso-vs-scim', 'gptbot', 'train', false, 'origin'),
  ('bbbbbbbb-0000-0000-0000-000000000002', now(), '/blog/widgets', 'perplexity-user', 'live_fetch', false, 'worker');
insert into analytics.crawl_daily (site_id, day, bot_family, purpose, source, path, hits, verified_hits) values
  ('aaaaaaaa-0000-0000-0000-000000000001', current_date, 'chatgpt-user', 'live_fetch', 'worker', '/resources/sso-vs-scim', 3, 3),
  ('bbbbbbbb-0000-0000-0000-000000000002', current_date, 'perplexity-user', 'live_fetch', 'worker', '/blog/widgets', 1, 0);
insert into ops.site_alerts (site_id, kind, path) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'site_mismatch', '/resources/x'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'loop', '/blog/y');

do $$ begin
  if exists (select 1 from analytics.crawl_events where org_id is null) then raise exception 'FAIL crawl_events org trigger'; end if;
  if exists (select 1 from analytics.crawl_daily where org_id is null) then raise exception 'FAIL crawl_daily org trigger'; end if;
  if exists (select 1 from ops.site_alerts where org_id is null) then raise exception 'FAIL site_alerts org trigger'; end if;
  if exists (select 1 from app.sites where length(proxy_hmac_secret) <> 48) then raise exception 'FAIL proxy_hmac_secret default'; end if;
  if (select count(distinct proxy_hmac_secret) from app.sites) <> (select count(*) from app.sites) then raise exception 'FAIL proxy secrets must be distinct'; end if;
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own crawl events', (select count(*) from analytics.crawl_events), 2);
  select pg_temp.expect('acme member sees own crawl_daily', (select count(*) from analytics.crawl_daily), 1);
  select pg_temp.expect('acme member sees own site alerts', (select count(*) from ops.site_alerts), 1);
  select pg_temp.expect('acme member reads own proxy secret only', (select count(*) from app.sites where proxy_hmac_secret is not null), 1);
  select pg_temp.expect('bot catalogue is readable', (select count(*) from ops.bots), 15);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('globex member never sees acme crawl events', (select count(*) from analytics.crawl_events where org_id = '11111111-1111-1111-1111-111111111111'), 0);
  select pg_temp.expect('globex member sees own alerts only', (select count(*) from ops.site_alerts), 1);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every crawl event', (select count(*) from analytics.crawl_events), 3);
rollback;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from analytics.crawl_events;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read analytics.crawl_events';
    end if;
    denied := false;
    begin
      perform 1 from ops.bots;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read ops.bots';
    end if;
  end $$;
rollback;

\echo 'isolation: crawl telemetry assertions passed'
