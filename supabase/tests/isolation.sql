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

-- ── 0011: org admin ─────────────────────────────────────────────────────────
grant select on all tables in schema app to app_user;

insert into app.org_invites (org_id, email, role, invited_by) values
  ('11111111-1111-1111-1111-111111111111', 'new@acme.com', 'editor', '99999999-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222', 'new@globex.com', 'viewer', null);

do $$ begin
  begin
    insert into app.org_invites (org_id, email, role) values ('11111111-1111-1111-1111-111111111111', 'NEW@acme.com', 'viewer');
    raise exception 'FAIL duplicate pending invite must be rejected';
  exception when unique_violation then null;
  end;
  begin
    insert into app.org_invites (org_id, email, role) values ('11111111-1111-1111-1111-111111111111', 'x@acme.com', 'owner');
    raise exception 'FAIL an invite may not grant owner';
  exception when check_violation then null;
  end;
  if (select count(*) from app.organizations where retention_days = 365 and plan_status = 'trialing') <> (select count(*) from app.organizations) then
    raise exception 'FAIL organization defaults';
  end if;
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own invites only', (select count(*) from app.org_invites), 1);
rollback;
begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every invite', (select count(*) from app.org_invites), 2);
rollback;
begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from app.org_invites;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read app.org_invites';
    end if;
  end $$;
rollback;

\echo 'isolation: org admin assertions passed'

-- Members may read memberships without tripping the (former) self-referential policy,
-- and an admin's write predicate resolves through the security-definer function.
begin;
  set local role app_user;
  set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-000000000001","org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme owner reads own memberships without recursion', (select count(*) from app.memberships where org_id = '11111111-1111-1111-1111-111111111111'), 1);
  select pg_temp.expect('acme owner is org admin', (select case when app.auth_is_org_admin('11111111-1111-1111-1111-111111111111') then 1 else 0 end)::bigint, 1);
  select pg_temp.expect('acme owner is not globex admin', (select case when app.auth_is_org_admin('22222222-2222-2222-2222-222222222222') then 1 else 0 end)::bigint, 0);
rollback;

\echo 'isolation: org admin policy assertions passed'

-- ── 0012: topics, competitor pages, publish targets ─────────────────────────
grant select on all tables in schema measure, content to app_user;
grant update on measure.topics to app_user;

insert into measure.topics (id, site_id, name, slug, priority, cadence_per_month, formats, seed_terms, competitor_domains) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'SCIM provisioning', 'scim-provisioning', 5, 4, '{comparison,guide}', '{scim,provisioning}', '{okta.com}'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Widgets', 'widgets', 2, 1, '{howto}', '{widget}', '{}');
update measure.questions set topic_id = 'eeeeeeee-0000-0000-0000-000000000001', pinned = true where id = 'dddddddd-0000-0000-0000-000000000001';
insert into measure.competitor_pages (site_id, topic_id, url, domain, title, content_type, word_count, citations_30d) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'https://okta.com/blog/scim', 'okta.com', 'SCIM explained', 'guide', 1800, 4),
  ('bbbbbbbb-0000-0000-0000-000000000002', null, 'https://initech.com/widgets', 'initech.com', 'Widgets', 'product', 300, 1);
insert into content.publish_targets (id, site_id, kind, name, config) values
  ('eeeeeeee-1000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'webflow', 'Acme blog', '{"collectionId":"c1","fieldMap":{"name":"name","slug":"slug","body":"post-body"},"publishLive":true,"canonicalMode":"proxy","autoPush":true}'),
  ('eeeeeeee-1000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'proxy', 'Globex proxy', '{}');
insert into content.external_publications (site_id, content_item_id, target_id, status, external_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-3000-0000-0000-000000000001', 'eeeeeeee-1000-0000-0000-000000000001', 'published', 'wf_1'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'dddddddd-3000-0000-0000-000000000002', 'eeeeeeee-1000-0000-0000-000000000002', 'pending', null);

do $$ begin
  if exists (select 1 from measure.topics where org_id is null) then raise exception 'FAIL topics org trigger'; end if;
  if exists (select 1 from measure.competitor_pages where org_id is null) then raise exception 'FAIL competitor_pages org trigger'; end if;
  if exists (select 1 from content.publish_targets where org_id is null) then raise exception 'FAIL publish_targets org trigger'; end if;
  if exists (select 1 from content.external_publications where org_id is null) then raise exception 'FAIL external_publications org trigger'; end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'connector_provider' and e.enumlabel = 'webflow') then raise exception 'FAIL webflow provider missing'; end if;
  begin
    insert into measure.topics (site_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Dup', 'scim-provisioning');
    raise exception 'FAIL duplicate topic slug must be rejected';
  exception when unique_violation then null;
  end;
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-000000000001","org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own topics', (select count(*) from measure.topics), 1);
  select pg_temp.expect('acme member sees own competitor pages', (select count(*) from measure.competitor_pages), 1);
  select pg_temp.expect('acme member sees own publish targets', (select count(*) from content.publish_targets), 1);
  select pg_temp.expect('acme member sees own external publications', (select count(*) from content.external_publications), 1);
  update measure.topics set priority = 4 where site_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select pg_temp.expect('tenant_write on topics touches own row only', (select count(*) from measure.topics where priority = 4), 1);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('globex member never sees acme topics', (select count(*) from measure.topics where org_id = '11111111-1111-1111-1111-111111111111'), 0);
rollback;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from measure.topics;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read measure.topics';
    end if;
    denied := false;
    begin
      perform 1 from content.publish_targets;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read content.publish_targets';
    end if;
  end $$;
rollback;

\echo 'isolation: topics and publishing assertions passed'

-- ── 0013: onboarding keywords + website profile ──────────────────────────────
update app.sites set keywords = '{scim,sso}', profile = '{"name":"Acme","oneLiner":"IAM for mid-market"}', profile_status = 'ready' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update app.sites set keywords = '{widgets}', profile_status = 'queued' where id = 'bbbbbbbb-0000-0000-0000-000000000002';

do $$ begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'connector_provider' and e.enumlabel = 'website') then raise exception 'FAIL website provider missing'; end if;
  begin
    update app.sites set profile_status = 'bogus' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'FAIL profile_status check must reject unknown states';
  exception when check_violation then null;
  end;
  begin
    update app.sites set profile = '[]'::jsonb where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'FAIL profile must be a JSON object';
  exception when check_violation then null;
  end;
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-000000000001","org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own site keywords only', (select count(*) from app.sites where 'scim' = any (keywords)), 1);
  select pg_temp.expect('acme member cannot see globex keywords', (select count(*) from app.sites where 'widgets' = any (keywords)), 0);
  select pg_temp.expect('acme member reads own profile', (select count(*) from app.sites where profile ->> 'name' = 'Acme'), 1);
rollback;

\echo 'isolation: onboarding assertions passed'

-- ── 0018: security hardening ─────────────────────────────────────────────────
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'ops' and table_name = 'webhook_events' and column_name in ('attempts', 'claimed_at', 'last_error')) <> 3 then
    raise exception 'FAIL webhook ledger claim columns missing';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'app' and table_name = 'sites' and column_name in ('worker_version', 'worker_seen_at')) <> 2 then
    raise exception 'FAIL worker version columns missing';
  end if;
end $$;

-- A connection may name a site of its own organisation only, whoever writes it.
do $$
declare refused boolean := false;
begin
  begin
    insert into context.context_connections (org_id, site_id, provider, secret_ref)
    values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002', 'google', null);
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'FAIL connection bound to another org''s site on insert'; end if;
  refused := false;
  begin
    update context.context_connections set site_id = 'bbbbbbbb-0000-0000-0000-000000000002'
      where id = 'cccccccc-0000-0000-0000-000000000001';
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'FAIL connection moved to another org''s site'; end if;
  raise notice 'ok  a connection cannot bind another org''s site';
end $$;

begin;
  insert into context.context_connections (id, org_id, site_id, provider, secret_ref)
  values ('cccccccc-0000-0000-0000-000000000018', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'google', null);
  select pg_temp.expect('a connection binds a site of its own org',
    (select count(*) from context.context_connections where id = 'cccccccc-0000-0000-0000-000000000018'), 1);
rollback;

grant insert, update on context.context_connections to app_user;
begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  do $$
  declare refused boolean := false;
  begin
    begin
      insert into context.context_connections (org_id, site_id, provider)
      values ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002', 'google');
    exception when check_violation then
      refused := true;
    end;
    if not refused then raise exception 'FAIL member bound a Globex site to an Acme connection'; end if;
    refused := false;
    begin
      update context.context_connections set site_id = 'bbbbbbbb-0000-0000-0000-000000000002'
        where id = 'cccccccc-0000-0000-0000-000000000001';
    exception when check_violation then
      refused := true;
    end;
    if not refused then raise exception 'FAIL member moved an Acme connection onto a Globex site'; end if;
    raise notice 'ok  a member cannot bind another org''s site through RLS';
  end $$;
rollback;
revoke insert, update on context.context_connections from app_user;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member still cannot read the webhook ledger', (select count(*) from ops.webhook_events), 0);
rollback;

\echo 'isolation: security hardening assertions passed'

-- ── 0019: measurement integrity ──────────────────────────────────────────────
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'measure' and table_name = 'questions' and column_name in ('last_mine_batch', 'last_measure_error', 'last_measure_error_at')) <> 3 then
    raise exception 'FAIL question mining/measure columns missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'measure' and table_name = 'question_clusters' and column_name = 'updated_by_run') then
    raise exception 'FAIL question_clusters.updated_by_run missing';
  end if;
end $$;

-- org_id deliberately omitted: the site trigger must fill it.
insert into app.metric_restatements (site_id, metric, old_value, new_value, methodology_version, reason) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'gsc_clicks_28d', 240, 120, '2026-10-r1', 'Each click counted once.'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'open_gaps', 7, 3, '2026-10-r1', 'Latest snapshot only.');

do $$ begin
  if exists (select 1 from app.metric_restatements where org_id is null) then raise exception 'FAIL metric_restatements org trigger'; end if;
  begin
    insert into app.metric_restatements (site_id, metric, old_value, new_value, methodology_version, reason)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'gsc_clicks_28d', 1, 1, '2026-10-r1', 'dup');
    raise exception 'FAIL a second restatement of one metric under one version must be rejected';
  exception when unique_violation then null;
  end;
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own restatements', (select count(*) from app.metric_restatements), 1);
  select pg_temp.expect('acme member never sees globex restatements',
    (select count(*) from app.metric_restatements where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every restatement', (select count(*) from app.metric_restatements), 2);
rollback;

begin;
  set local role app_user;
  do $$ begin
    if (select count(*) from app.metric_restatements) <> 0 then raise exception 'FAIL restatements readable without claims'; end if;
    raise notice 'ok  absent claims see no restatements';
  end $$;
rollback;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from app.metric_restatements;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read app.metric_restatements';
    end if;
    raise notice 'ok  renderer cannot read app.metric_restatements';
  end $$;
rollback;

\echo 'isolation: measurement integrity assertions passed'

-- ── 0020: takedown and kill switch ───────────────────────────────────────────
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'content' and table_name = 'published_pages' and column_name in ('status', 'version_id', 'previous_version_id', 'status_changed_at', 'status_reason')) <> 5 then
    raise exception 'FAIL published_pages takedown columns missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'sites' and column_name = 'indexing_paused') then
    raise exception 'FAIL sites.indexing_paused missing';
  end if;
end $$;

-- The renderer reads a page's status and the site's pause with the grants it already had.
begin;
  update content.published_pages set status = 'noindex' where site_id = 'aaaaaaaa-0000-0000-0000-000000000001' and path = '/resources/hello';
  set local role renderer;
  select pg_temp.expect('renderer reads published_pages.status',
    (select count(*) from content.published_pages where status = 'noindex'), 1);
  select pg_temp.expect('renderer reads site_render_config.indexing_paused',
    (select count(*) from content.site_render_config where not indexing_paused), 2);
rollback;

-- The owner's flag and every control scope reach the renderer's copy.
begin;
  update app.sites set indexing_paused = true where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select pg_temp.expect('site flag pauses its own render config',
    (select count(*) from content.site_render_config where indexing_paused), 1);
  update app.sites set indexing_paused = false where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select pg_temp.expect('lifting the site flag clears it',
    (select count(*) from content.site_render_config where indexing_paused), 0);

  insert into ops.autonomy_controls (scope, org_id, indexing_paused) values ('org', '22222222-2222-2222-2222-222222222222', true);
  select pg_temp.expect('org control pauses that org''s sites only',
    (select count(*) from content.site_render_config where indexing_paused and site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 1);
  select pg_temp.expect('org control leaves other orgs indexed',
    (select count(*) from content.site_render_config where indexing_paused and site_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0);

  -- org_id deliberately omitted: the trigger takes it from the site.
  insert into ops.autonomy_controls (scope, site_id, indexing_paused, publishing_paused) values ('site', 'aaaaaaaa-0000-0000-0000-000000000001', true, true);
  select pg_temp.expect('site control carries its site''s org',
    (select count(*) from ops.autonomy_controls where scope = 'site' and org_id = '11111111-1111-1111-1111-111111111111'), 1);
  select pg_temp.expect('site control pauses its site',
    (select count(*) from content.site_render_config where indexing_paused), 2);

  delete from ops.autonomy_controls where scope = 'site';
  update ops.autonomy_controls set indexing_paused = false where scope = 'org';
  select pg_temp.expect('lifted controls clear the pause',
    (select count(*) from content.site_render_config where indexing_paused), 0);

  insert into ops.autonomy_controls (scope, indexing_paused) values ('global', true);
  select pg_temp.expect('global control pauses every site',
    (select count(*) from content.site_render_config where indexing_paused), 2);
rollback;

do $$ begin
  begin
    insert into ops.autonomy_controls (scope, org_id) values ('global', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL a global control must not name an org';
  exception when check_violation then null;
  end;
  begin
    insert into ops.autonomy_controls (scope) values ('org');
    raise exception 'FAIL an org control must name its org';
  exception when check_violation then null;
  end;
  begin
    insert into ops.autonomy_controls (scope, publishing_paused) values ('global', true), ('global', false);
    raise exception 'FAIL a second global control must be rejected';
  exception when unique_violation then null;
  end;
  raise notice 'ok  control scopes are well formed and one per scope';
end $$;

begin;
  insert into ops.autonomy_controls (scope, org_id, publishing_paused, reason) values ('org', '11111111-1111-1111-1111-111111111111', true, 'billing dispute');
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('member cannot read the kill switches, even their own org''s', (select count(*) from ops.autonomy_controls), 0);
rollback;

begin;
  insert into ops.autonomy_controls (scope, org_id, publishing_paused) values ('org', '11111111-1111-1111-1111-111111111111', true);
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff reads the kill switches', (select count(*) from ops.autonomy_controls), 1);
rollback;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from ops.autonomy_controls;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read ops.autonomy_controls';
    end if;
    raise notice 'ok  renderer cannot read ops.autonomy_controls';
  end $$;
rollback;

\echo 'isolation: takedown and kill switch assertions passed'

-- ── 0021: spend governor ─────────────────────────────────────────────────────
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'ops' and table_name = 'llm_calls' and column_name in ('run_id', 'opportunity_id', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'stop_reason')) <> 5 then
    raise exception 'FAIL llm_calls spend columns missing';
  end if;
end $$;

insert into ops.budgets (id, org_id, resource, cap_usd) values
  ('d1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'llm', 200),
  ('d2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'llm', 200);
-- org_id deliberately wrong on the site budget: the trigger takes it from the site.
insert into ops.budgets (id, org_id, site_id, resource, period, cap_usd) values
  ('d1000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'serp', 'day', 5);
-- org_id deliberately omitted on counters and holds: the counter trigger takes it from the budget.
insert into ops.spend_counters (budget_id, period_start, spent_usd, reserved_usd) values
  ('d1000000-0000-0000-0000-000000000001', date_trunc('month', now())::date, 12.5, 0.4),
  ('d1000000-0000-0000-0000-000000000003', current_date, 1, 0),
  ('d2000000-0000-0000-0000-000000000002', date_trunc('month', now())::date, 3, 0);
insert into ops.spend_reservations (org_id, resource, budget_ids, amount_usd, ref) values
  ('11111111-1111-1111-1111-111111111111', 'llm', '{d1000000-0000-0000-0000-000000000001}', 0.4, '{"task":"pipeline.draft"}'),
  ('22222222-2222-2222-2222-222222222222', 'serp', '{d2000000-0000-0000-0000-000000000002}', 0.02, '{"query":"sso vs scim"}');

do $$ begin
  if (select org_id from ops.budgets where id = 'd1000000-0000-0000-0000-000000000003') <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FAIL a site budget must carry its site''s org';
  end if;
  if exists (select 1 from ops.spend_counters c join ops.budgets b on b.id = c.budget_id where c.org_id is distinct from b.org_id) then
    raise exception 'FAIL spend_counters org trigger';
  end if;
  begin
    insert into ops.budgets (org_id, resource, cap_usd) values ('11111111-1111-1111-1111-111111111111', 'llm', 50);
    raise exception 'FAIL a second org-wide monthly llm budget must be rejected';
  exception when unique_violation then null;
  end;
  begin
    insert into ops.budgets (org_id, resource, period, cap_usd) values ('11111111-1111-1111-1111-111111111111', 'llm', 'week', 50);
    raise exception 'FAIL an unknown budget period must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into ops.spend_reservations (org_id, resource, budget_ids, amount_usd, status) values ('11111111-1111-1111-1111-111111111111', 'llm', '{}', 1, 'spent');
    raise exception 'FAIL an unknown reservation status must be rejected';
  exception when check_violation then null;
  end;
  raise notice 'ok  budgets are one per scope and carry their org';
end $$;

-- Changing the org's SERP budget in its settings moves the governor's cap.
begin;
  insert into ops.budgets (org_id, resource, cap_usd) values ('11111111-1111-1111-1111-111111111111', 'serp', 25);
  update app.organizations set serp_monthly_budget_usd = 60 where id = '11111111-1111-1111-1111-111111111111';
  select pg_temp.expect('org serp setting moves the monthly serp cap',
    (select cap_usd::int from ops.budgets where org_id = '11111111-1111-1111-1111-111111111111' and site_id is null and resource = 'serp'), 60);
  select pg_temp.expect('org serp setting leaves site budgets alone',
    (select cap_usd::int from ops.budgets where id = 'd1000000-0000-0000-0000-000000000003'), 5);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own budgets', (select count(*) from ops.budgets), 2);
  select pg_temp.expect('acme member never sees globex budgets',
    (select count(*) from ops.budgets where org_id = '22222222-2222-2222-2222-222222222222'), 0);
  select pg_temp.expect('acme member sees own spend counters', (select count(*) from ops.spend_counters), 2);
  select pg_temp.expect('acme member never sees globex counters',
    (select count(*) from ops.spend_counters where budget_id = 'd2000000-0000-0000-0000-000000000002'), 0);
  select pg_temp.expect('member cannot read spend holds, even their own org''s', (select count(*) from ops.spend_reservations), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('globex member sees only globex budgets', (select count(*) from ops.budgets), 1);
  select pg_temp.expect('globex member never sees acme counters',
    (select count(*) from ops.spend_counters where org_id = '11111111-1111-1111-1111-111111111111'), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every budget', (select count(*) from ops.budgets), 3);
  select pg_temp.expect('staff sees every counter', (select count(*) from ops.spend_counters), 3);
  select pg_temp.expect('staff reads spend holds', (select count(*) from ops.spend_reservations), 2);
rollback;

begin;
  set local role app_user;
  do $$ begin
    if (select count(*) from ops.budgets) + (select count(*) from ops.spend_counters) <> 0 then raise exception 'FAIL budgets readable without claims'; end if;
    raise notice 'ok  absent claims see no budgets';
  end $$;
rollback;

begin;
  set local role renderer;
  do $$
  declare t text;
  declare denied boolean;
  begin
    foreach t in array array['ops.budgets', 'ops.spend_counters', 'ops.spend_reservations'] loop
      denied := false;
      begin
        execute format('select 1 from %s limit 1', t);
      exception when insufficient_privilege then
        denied := true;
      end;
      if not denied then
        raise exception 'FAIL renderer must not read %', t;
      end if;
    end loop;
    raise notice 'ok  renderer cannot read budgets, counters or holds';
  end $$;
rollback;

\echo 'isolation: spend governor assertions passed'

-- ── 0022: source roles ───────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'context' and table_name = 'entities' and column_name = 'domains') then
    raise exception 'FAIL entities.domains missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'measure' and table_name = 'serp_citations' and column_name = 'source_role' and is_nullable = 'NO') then
    raise exception 'FAIL serp_citations.source_role missing or nullable';
  end if;
  if (select count(*) from measure.source_domains where classified_by = 'seed') < 200 then
    raise exception 'FAIL the source catalogue seed is missing';
  end if;
end $$;

-- The 0004 fixture citation was written after 0022 without a role: the trigger gave it one.
select pg_temp.expect('a citation written without a role is classified on insert',
  (select count(*) from measure.serp_citations where domain = 'competitor.com' and source_role = 'unknown'), 1);

-- Acme names Okta (the 0007 fixture) with its domain; each site overrides one catalogue domain.
update context.entities set domains = '{okta.com}' where id = 'eeeeeeee-2000-0000-0000-000000000002';
-- org_id deliberately omitted: the site trigger must fill it.
insert into measure.site_source_overrides (site_id, domain, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'medium.com', 'vendor_other'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'reddit.com', 'review_platform');

do $$ begin
  if exists (select 1 from measure.site_source_overrides where org_id is null) then raise exception 'FAIL site_source_overrides org trigger'; end if;
  begin
    insert into measure.site_source_overrides (site_id, domain, role) values ('aaaaaaaa-0000-0000-0000-000000000001', 'medium.com', 'analyst');
    raise exception 'FAIL a second override of one domain on one site must be rejected';
  exception when unique_violation then null;
  end;
  begin
    insert into measure.site_source_overrides (site_id, domain, role) values ('aaaaaaaa-0000-0000-0000-000000000001', 'okta.com', 'competitor');
    raise exception 'FAIL an override must not name a competitor (that is an entity)';
  exception when check_violation then null;
  end;
  begin
    insert into measure.site_source_overrides (site_id, domain, role) values ('aaaaaaaa-0000-0000-0000-000000000001', 'acme.io', 'owned');
    raise exception 'FAIL an override must not claim ownership';
  exception when check_violation then null;
  end;
  begin
    insert into measure.site_source_overrides (site_id, domain, role) values ('aaaaaaaa-0000-0000-0000-000000000001', 'https://www.quora.com/x', 'video');
    raise exception 'FAIL an override domain must be normalised';
  exception when check_violation then null;
  end;
  begin
    insert into measure.source_domains (domain, role) values ('rival.example', 'competitor');
    raise exception 'FAIL the global catalogue must not name competitors';
  exception when check_violation then null;
  end;
  begin
    update context.entities set domains = '{WWW.Okta.com}' where id = 'eeeeeeee-2000-0000-0000-000000000002';
    raise exception 'FAIL entity domains must be normalised';
  exception when check_violation then null;
  end;
  raise notice 'ok  overrides, catalogue rows and entity domains are well formed';
end $$;

-- Precedence: owned, override, competitor, catalogue (longest match), unknown.
select pg_temp.expect('the site''s own domain and subdomains are owned',
  (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'https://docs.acme.com/x') where role = 'owned'), 1);
select pg_temp.expect('a competitor''s domain and its subdomains are that competitor',
  (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'www.blog.okta.com')
    where role = 'competitor' and entity_id = 'eeeeeeee-2000-0000-0000-000000000002'), 1);
select pg_temp.expect('another org''s competitor is not this site''s',
  (select count(*) from measure.classify_source('bbbbbbbb-0000-0000-0000-000000000002', 'okta.com') where role = 'unknown'), 1);
select pg_temp.expect('a site override beats the catalogue',
  (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'medium.com') where role = 'vendor_other'), 1);
select pg_temp.expect('an override is its own site''s only',
  (select count(*) from measure.classify_source('bbbbbbbb-0000-0000-0000-000000000002', 'medium.com') where role = 'publisher_editorial'), 1);
select pg_temp.expect('the longest catalogue match wins',
  (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'answers.microsoft.com') where role = 'ugc_forum'), 1);
select pg_temp.expect('a subdomain takes its catalogue domain''s role',
  (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'en.wikipedia.org') where role = 'reference_wiki'), 1);
select pg_temp.expect('an unlisted domain is unknown',
  (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'rival.example') where role = 'unknown' and entity_id is null), 1);

-- The insert trigger applies the same precedence.
begin;
  insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'ai_overview', 'https://blog.okta.com/scim', 'blog.okta.com', 2, false),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'ai_overview', 'https://www.reddit.com/r/sso', 'reddit.com', 3, false),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'ai_overview', 'https://acme.com/resources/scim', 'acme.com', 4, true);
  select pg_temp.expect('a competitor citation carries its entity',
    (select count(*) from measure.serp_citations where domain = 'blog.okta.com' and source_role = 'competitor' and entity_id = 'eeeeeeee-2000-0000-0000-000000000002'), 1);
  select pg_temp.expect('reddit is a forum, not a competitor',
    (select count(*) from measure.serp_citations where domain = 'reddit.com' and source_role = 'ugc_forum' and entity_id is null), 1);
  select pg_temp.expect('an owned citation is owned',
    (select count(*) from measure.serp_citations where domain = 'acme.com' and source_role = 'owned'), 1);
rollback;

-- Watched topic domains become competitors: by name when one entity spells it, unconfirmed otherwise.
begin;
  insert into context.entities (org_id, type, name) values ('11111111-1111-1111-1111-111111111111', 'competitor', 'OneLogin');
  select pg_temp.expect('seeding reports what it attached or added',
    (select count(*) from measure.seed_competitor_domains('11111111-1111-1111-1111-111111111111',
      '{https://www.onelogin.com/blog,jumpcloud.com,login.jumpcloud.com,okta.com,blog.okta.com,g2.com,acme.com,docs.acme.com,salesforce.com,app.rippling.com,rippling.com,not a domain}')), 4);
  select pg_temp.expect('a watched domain joins the competitor whose name it spells',
    (select count(*) from context.entities where org_id = '11111111-1111-1111-1111-111111111111' and name = 'OneLogin' and domains = '{onelogin.com}'), 1);
  select pg_temp.expect('an unmatched watched domain becomes an unconfirmed competitor',
    (select count(*) from context.entities where org_id = '11111111-1111-1111-1111-111111111111' and name = 'jumpcloud.com'
       and type = 'competitor' and domains = '{jumpcloud.com}' and metadata ? 'seeded_from'), 1);
  select pg_temp.expect('a vendor watched as a rival is a competitor',
    (select count(*) from context.entities where org_id = '11111111-1111-1111-1111-111111111111' and 'salesforce.com' = any (domains)), 1);
  select pg_temp.expect('a review site watched as a rival stays a review site',
    (select count(*) from context.entities where 'g2.com' = any (domains)), 0);
  select pg_temp.expect('the org''s own domains are never competitors',
    (select count(*) from context.entities where domains && '{acme.com,docs.acme.com}'), 0);
  select pg_temp.expect('a domain a competitor has already is left alone',
    (select count(*) from context.entities where 'okta.com' = any (domains)), 1);
  select pg_temp.expect('a subdomain of a competitor''s domain is that competitor''s, whichever was watched first',
    (select count(*) from context.entities where domains && '{blog.okta.com,login.jumpcloud.com,app.rippling.com}'), 0);
  select pg_temp.expect('a watched subdomain folds into its domain''s competitor',
    (select count(*) from context.entities where org_id = '11111111-1111-1111-1111-111111111111' and domains = '{rippling.com}'), 1);
  select pg_temp.expect('a watched subdomain is that competitor''s citation',
    (select count(*) from measure.classify_source('aaaaaaaa-0000-0000-0000-000000000001', 'login.jumpcloud.com') r
       join context.entities e on e.id = r.entity_id where e.name = 'jumpcloud.com'), 1);
  select pg_temp.expect('seeding is per org',
    (select count(*) from context.entities where org_id = '22222222-2222-2222-2222-222222222222' and type = 'competitor'), 0);
rollback;

-- "Not a competitor" sticks: a watched domain named after an entity someone removed is not seeded again.
begin;
  insert into context.entities (org_id, type, name, metadata)
  values ('11111111-1111-1111-1111-111111111111', 'other', 'ping.example', '{"removed_as_competitor_at": "2026-10-01T00:00:00Z"}');
  select pg_temp.expect('a removed competitor''s domain is not seeded again',
    (select count(*) from measure.seed_competitor_domains('11111111-1111-1111-1111-111111111111', '{ping.example}')), 0);
  select pg_temp.expect('the removed entity stays an ordinary one',
    (select count(*) from context.entities where name = 'ping.example' and type = 'other' and domains = '{}'), 1);
rollback;

-- A watched domain an entity of another kind is named after is not a competitor, and is not reported as one.
begin;
  insert into context.entities (org_id, type, name) values
    ('11111111-1111-1111-1111-111111111111', 'integration', 'slack.example'),
    ('11111111-1111-1111-1111-111111111111', 'other', 'asana.example');
  create temp table seeded on commit drop as
    select domain from measure.seed_competitor_domains('11111111-1111-1111-1111-111111111111', '{slack.example,asana.example}');
  select pg_temp.expect('seeding reports only what landed on a competitor',
    (select count(*) from seeded), 1);
  select pg_temp.expect('the domain reported is the one now a competitor''s',
    (select count(*) from seeded where domain = 'asana.example'), 1);
  select pg_temp.expect('an integration named after a watched domain keeps its type and gets no domain',
    (select count(*) from context.entities where name = 'slack.example' and type = 'integration' and domains = '{}'), 1);
  select pg_temp.expect('no competitor holds a domain an integration is named after',
    (select count(*) from context.entities where 'slack.example' = any (domains)), 0);
  select pg_temp.expect('an ordinary entity named after a watched domain becomes the competitor',
    (select count(*) from context.entities where name = 'asana.example' and type = 'competitor' and domains = '{asana.example}'), 1);
rollback;

grant insert, update, delete on measure.site_source_overrides to app_user;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member reads the source catalogue', (select (count(*) >= 200)::int from measure.source_domains), 1);
  select pg_temp.expect('acme member sees own overrides', (select count(*) from measure.site_source_overrides), 1);
  select pg_temp.expect('acme member never sees globex overrides',
    (select count(*) from measure.site_source_overrides where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0);
  select pg_temp.expect('acme member sees own competitor domains',
    (select count(*) from context.entities where 'okta.com' = any (domains)), 1);
  update measure.site_source_overrides set role = 'analyst';
  select pg_temp.expect('tenant_write on overrides touches own rows only', (select count(*) from measure.site_source_overrides where role = 'analyst'), 1);
rollback;

-- An override is filed under its site's org whoever writes it and whatever org they pass.
begin;
  insert into measure.site_source_overrides (site_id, org_id, domain, role)
  values ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'quora.com', 'video');
  select pg_temp.expect('an override takes its site''s org, not the one written',
    (select count(*) from measure.site_source_overrides where domain = 'quora.com' and org_id = '11111111-1111-1111-1111-111111111111'), 1);
  update measure.site_source_overrides set org_id = '22222222-2222-2222-2222-222222222222' where domain = 'quora.com';
  select pg_temp.expect('an override''s org cannot be changed away from its site''s',
    (select count(*) from measure.site_source_overrides where domain = 'quora.com' and org_id = '11111111-1111-1111-1111-111111111111'), 1);
  update measure.site_source_overrides set site_id = 'bbbbbbbb-0000-0000-0000-000000000002' where domain = 'quora.com';
  select pg_temp.expect('an override moved to another site takes that site''s org',
    (select count(*) from measure.site_source_overrides where domain = 'quora.com' and org_id = '22222222-2222-2222-2222-222222222222'), 1);
rollback;

-- Even a row filed under the wrong org some other way never steers the site it names.
begin;
  alter table measure.site_source_overrides disable trigger site_source_overrides_org;
  insert into measure.site_source_overrides (site_id, org_id, domain, role)
  values ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'quora.com', 'video');
  select pg_temp.expect('classify_source ignores an override filed under another org',
    (select count(*) from measure.classify_source('bbbbbbbb-0000-0000-0000-000000000002', 'quora.com') where role = 'ugc_forum'), 1);
rollback;

-- A member cannot file an override against another org's site under their own org, or move one there.
begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  do $$
  declare refused boolean := false;
  begin
    begin
      insert into measure.site_source_overrides (site_id, org_id, domain, role)
      values ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'acme.com', 'publisher_editorial');
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then raise exception 'FAIL an acme member filed an override against a globex site under acme'; end if;
    refused := false;
    begin
      update measure.site_source_overrides set site_id = 'bbbbbbbb-0000-0000-0000-000000000002', role = 'ugc_forum'
        where domain = 'medium.com';
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then raise exception 'FAIL an acme member moved its override onto a globex site'; end if;
    raise notice 'ok  a member cannot steer another org''s site through an override';
  end $$;
rollback;
select pg_temp.expect('globex''s roles are untouched by acme''s attempts',
  (select count(*) from measure.site_source_overrides where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 1);

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  do $$
  declare denied boolean := false;
  begin
    begin
      insert into measure.site_source_overrides (site_id, org_id, domain, role)
      values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'quora.com', 'video');
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL a globex member must not override a role on an acme site';
    end if;
    raise notice 'ok  a member cannot write another org''s overrides';
  end $$;
  select pg_temp.expect('globex member never sees acme competitor domains',
    (select count(*) from context.entities where 'okta.com' = any (domains)), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every override', (select count(*) from measure.site_source_overrides), 2);
rollback;

begin;
  set local role app_user;
  do $$ begin
    if (select count(*) from measure.site_source_overrides) <> 0 then raise exception 'FAIL overrides readable without claims'; end if;
    raise notice 'ok  absent claims see no overrides';
  end $$;
rollback;

begin;
  set local role renderer;
  do $$
  declare t text;
  declare denied boolean;
  begin
    foreach t in array array['measure.source_domains', 'measure.site_source_overrides'] loop
      denied := false;
      begin
        execute format('select 1 from %s limit 1', t);
      exception when insufficient_privilege then
        denied := true;
      end;
      if not denied then
        raise exception 'FAIL renderer must not read %', t;
      end if;
    end loop;
    raise notice 'ok  renderer cannot read the source catalogue or overrides';
  end $$;
rollback;

\echo 'isolation: source role assertions passed'

-- ── 0023/0024: answer ledger ─────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'measure' and t.typname = 'citation_surface' and e.enumlabel = 'llm_answer')
     or not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
                    where n.nspname = 'measure' and t.typname = 'citation_surface' and e.enumlabel = 'ai_mode')
     or not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
                    where n.nspname = 'measure' and t.typname = 'serp_provider' and e.enumlabel = 'openrouter') then
    raise exception 'FAIL answer ledger enum values missing';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'measure' and table_name = 'serp_snapshots'
      and column_name in ('engine', 'model_version', 'collection_method', 'sample_index', 'paraphrase_id', 'run_id', 'answer_text', 'answer_hash', 'citations_observable')) <> 9 then
    raise exception 'FAIL answer ledger snapshot columns missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'measure' and table_name = 'serp_citations' and column_name = 'position_in_answer') then
    raise exception 'FAIL serp_citations.position_in_answer missing';
  end if;
  raise notice 'ok  answer ledger enums and columns present';
end $$;

-- A native row stays a Google SERP row; Profound and probe rows are labelled
-- by the trigger, whatever the writer sent.
insert into measure.serp_snapshots (id, site_id, question_id, provider, fetched_at, locale, device, aio_triggered, collection_method, raw) values
  ('f7000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
   'profound', now(), 'us-en', 'desktop', true, 'serp', '{"engine": "chatgpt"}'),
  ('f7000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
   'profound', now(), 'us-en', 'desktop', true, 'serp', '{"engine": "google_aio"}');
insert into measure.serp_snapshots (id, site_id, question_id, provider, fetched_at, locale, device, engine, model_version, run_id, answer_text, citations_observable) values
  ('f7000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
   'openrouter', now(), 'us-en', 'api', 'perplexity', 'perplexity/sonar+web:native', 'run-acme', 'Okta and Acme both do SCIM.', true),
  ('f7000000-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002',
   'openrouter', now(), 'us-en', 'api', 'perplexity', 'perplexity/sonar+web:native', 'run-globex', 'Globex is cheaper.', true);
insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001', 'llm_answer', 'https://www.okta.com/scim', 'okta.com', 1, false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000003', 'llm_answer', 'https://acme.com/resources/scim', 'acme.com', 1, true),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'f7000000-0000-0000-0000-000000000004', 'llm_answer', 'https://globex.com/pricing', 'globex.com', 1, true);
-- org_id and site_id deliberately wrong: the trigger takes both from the snapshot.
insert into measure.answer_mentions (snapshot_id, org_id, site_id, entity_id, is_brand, matched_alias, first_offset, extractor_version) values
  ('f7000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002',
   'eeeeeeee-2000-0000-0000-000000000002', false, 'okta', 0, 'mentions-v0'),
  ('f7000000-0000-0000-0000-000000000003', null, 'aaaaaaaa-0000-0000-0000-000000000001',
   'eeeeeeee-2000-0000-0000-000000000001', true, 'acme', 9, 'mentions-v0'),
  ('f7000000-0000-0000-0000-000000000004', null, 'bbbbbbbb-0000-0000-0000-000000000002',
   'eeeeeeee-2000-0000-0000-000000000003', true, 'globex', 0, 'mentions-v0');

begin;
  select pg_temp.expect('a native snapshot is a google serp row',
    (select count(*) from measure.serp_snapshots where id = 'eeeeeeee-0000-0000-0000-000000000001' and engine = 'google' and collection_method = 'serp'), 1);
  select pg_temp.expect('a Profound row is third-party data on its engine, with no AI Overview flag',
    (select count(*) from measure.serp_snapshots where id = 'f7000000-0000-0000-0000-000000000001'
       and engine = 'chatgpt' and collection_method = 'third_party' and aio_triggered is null), 1);
  select pg_temp.expect('a Profound AI Overview row keeps its flag',
    (select count(*) from measure.serp_snapshots where id = 'f7000000-0000-0000-0000-000000000002'
       and engine = 'google_aio' and collection_method = 'third_party' and aio_triggered), 1);
  select pg_temp.expect('an OpenRouter row is an api probe',
    (select count(*) from measure.serp_snapshots where provider = 'openrouter' and collection_method = 'api_probe'), 2);
  select pg_temp.expect('a mention takes its site and org from the snapshot',
    (select count(*) from measure.answer_mentions where snapshot_id = 'f7000000-0000-0000-0000-000000000003'
       and site_id = 'aaaaaaaa-0000-0000-0000-000000000001' and org_id = '11111111-1111-1111-1111-111111111111'), 2);
  select pg_temp.expect('v_native_aio holds our SERP trackers'' rows only',
    (select count(*) from measure.v_native_aio where provider not in ('dataforseo', 'serpapi') or collection_method <> 'serp'), 0);
  select pg_temp.expect('v_native_aio never holds a Profound or probe row',
    (select count(*) from measure.v_native_aio where id::text like 'f7000000-%'), 0);
  select pg_temp.expect('v_answer_observations holds the Profound and probe rows with their topic',
    (select count(*) from measure.v_answer_observations where id::text like 'f7000000-%'
       and (question_id <> 'dddddddd-0000-0000-0000-000000000001' or topic_id = 'eeeeeeee-0000-0000-0000-000000000001')), 4);
  select pg_temp.expect('v_answer_observations never holds a native row',
    (select count(*) from measure.v_answer_observations where collection_method = 'serp'), 0);
commit;

do $$ begin
  begin
    update measure.serp_snapshots set collection_method = 'serp' where id = 'f7000000-0000-0000-0000-000000000001';
    raise exception 'FAIL a Profound row must not be labelled a SERP row';
  exception when check_violation then null;
  end;
  begin
    update measure.serp_snapshots set collection_method = 'third_party' where id = 'eeeeeeee-0000-0000-0000-000000000001';
    raise exception 'FAIL a native row must not be labelled third-party';
  exception when check_violation then null;
  end;
  begin
    insert into measure.answer_mentions (snapshot_id, entity_id, matched_alias, extractor_version)
    values ('f7000000-0000-0000-0000-000000000003', 'eeeeeeee-2000-0000-0000-000000000003', 'globex', 'mentions-v0');
    raise exception 'FAIL a mention must not name another org''s entity';
  exception when check_violation then null;
  end;
  begin
    update measure.answer_mentions set snapshot_id = 'f7000000-0000-0000-0000-000000000004'
    where snapshot_id = 'f7000000-0000-0000-0000-000000000003' and entity_id = 'eeeeeeee-2000-0000-0000-000000000002';
    raise exception 'FAIL a mention must not move to another org''s snapshot';
  exception when check_violation then null;
  end;
  raise notice 'ok  method labels and mention scope cannot be forged';
end $$;

-- The backfill labels rows stored before the ledger, once.
begin;
  alter table measure.serp_snapshots disable trigger serp_snapshots_collection;
  alter table measure.serp_snapshots drop constraint serp_snapshots_collection_check;
  insert into measure.serp_snapshots (id, site_id, question_id, provider, fetched_at, locale, device, aio_triggered, raw) values
    ('f7000000-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
     'profound', now(), 'us-en', 'desktop', true, '{"engine": "ai_mode"}'),
    ('f7000000-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
     'profound', now(), 'us-en', 'desktop', true, '{"engine": "perplexity"}');
  insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000011', 'ai_overview', 'https://okta.com/a', 'okta.com', 1, false),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000012', 'ai_overview', 'https://okta.com/b', 'okta.com', 1, false);
  alter table measure.serp_snapshots enable trigger serp_snapshots_collection;
  select pg_temp.expect('the backfill labels each old Profound row',
    (select snapshots from measure.backfill_answer_ledger()), 2);
  select pg_temp.expect('backfilled rows carry their engine and method, with no AI Overview flag',
    (select count(*) from measure.serp_snapshots where id in ('f7000000-0000-0000-0000-000000000011', 'f7000000-0000-0000-0000-000000000012')
       and collection_method = 'third_party' and engine in ('ai_mode', 'perplexity') and aio_triggered is null), 2);
  select pg_temp.expect('an AI Mode citation moves to the ai_mode surface',
    (select count(*) from measure.serp_citations where serp_snapshot_id = 'f7000000-0000-0000-0000-000000000011' and surface = 'ai_mode'), 1);
  select pg_temp.expect('another engine''s citation moves to llm_answer',
    (select count(*) from measure.serp_citations where serp_snapshot_id = 'f7000000-0000-0000-0000-000000000012' and surface = 'llm_answer'), 1);
  select pg_temp.expect('the backfill is idempotent',
    (select snapshots + citations from measure.backfill_answer_ledger()), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own answer mentions', (select count(*) from measure.answer_mentions), 2);
  select pg_temp.expect('acme member reads own probes through the answer view',
    (select count(*) from measure.v_answer_observations where provider = 'openrouter'), 1);
  select pg_temp.expect('acme member reads own native rows through the native view',
    (select count(*) from measure.v_native_aio where id = 'eeeeeeee-0000-0000-0000-000000000001'), 1);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('globex member sees only globex answer mentions', (select count(*) from measure.answer_mentions), 1);
  select pg_temp.expect('globex member sees no acme rows through the answer view',
    (select count(*) from measure.v_answer_observations where org_id = '11111111-1111-1111-1111-111111111111'), 0);
  select pg_temp.expect('globex member sees no acme rows through the native view',
    (select count(*) from measure.v_native_aio where org_id = '11111111-1111-1111-1111-111111111111'), 0);
  select pg_temp.expect('globex member sees its own probe',
    (select count(*) from measure.v_answer_observations), 1);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every answer mention', (select count(*) from measure.answer_mentions), 3);
rollback;

begin;
  set local role app_user;
  do $$ begin
    if (select count(*) from measure.answer_mentions) + (select count(*) from measure.v_answer_observations) + (select count(*) from measure.v_native_aio) <> 0 then
      raise exception 'FAIL answer ledger readable without claims';
    end if;
    raise notice 'ok  absent claims see no answers through the views';
  end $$;
rollback;

begin;
  set local role renderer;
  do $$
  declare t text;
  declare denied boolean;
  begin
    foreach t in array array['measure.answer_mentions', 'measure.v_native_aio', 'measure.v_answer_observations'] loop
      denied := false;
      begin
        execute format('select 1 from %s limit 1', t);
      exception when insufficient_privilege then
        denied := true;
      end;
      if not denied then
        raise exception 'FAIL renderer must not read %', t;
      end if;
    end loop;
    raise notice 'ok  renderer cannot read answer mentions or the answer views';
  end $$;
rollback;

\echo 'isolation: answer ledger assertions passed'

-- ── 0025: opportunity scoring ────────────────────────────────────────────────
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'content' and table_name = 'opportunities' and column_name in ('action_type', 'dismiss_reason')) <> 2 then
    raise exception 'FAIL opportunity action_type / dismiss_reason missing';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'measure' and table_name = 'questions' and column_name in ('search_volume', 'keyword_difficulty', 'search_intent')) <> 3 then
    raise exception 'FAIL question keyword columns missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'content' and table_name = 'content_items' and column_name = 'pipeline_published_at') then
    raise exception 'FAIL content_items.pipeline_published_at missing';
  end if;
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'content' and t.typname = 'action_type') <> 6 then
    raise exception 'FAIL content.action_type must have six values';
  end if;
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'content' and t.typname = 'dismiss_reason') <> 10 then
    raise exception 'FAIL content.dismiss_reason must have ten values';
  end if;
  raise notice 'ok  opportunity scoring enums and columns present';
end $$;

begin;
  select pg_temp.expect('an opportunity is a new page unless it says otherwise',
    (select count(*) from content.opportunities where id in ('dddddddd-1000-0000-0000-000000000001', 'dddddddd-1000-0000-0000-000000000002') and action_type = 'new_page'), 2);
  update content.opportunities set status = 'dismissed', dismiss_reason = 'auto_coverage', dismissed_reason = 'acme.com/sso already ranks #3'
  where id = 'dddddddd-1000-0000-0000-000000000001';
  select pg_temp.expect('a dismissal keeps its reason',
    (select count(*) from content.opportunities where id = 'dddddddd-1000-0000-0000-000000000001' and dismiss_reason = 'auto_coverage'), 1);
  update content.opportunities set status = 'open' where id = 'dddddddd-1000-0000-0000-000000000001';
  select pg_temp.expect('reopening clears the reason',
    (select count(*) from content.opportunities where id = 'dddddddd-1000-0000-0000-000000000001' and dismiss_reason is null), 1);
  update content.opportunities set status = 'open', dismiss_reason = 'low_value' where id = 'dddddddd-1000-0000-0000-000000000001';
  select pg_temp.expect('an open opportunity carries no reason',
    (select count(*) from content.opportunities where id = 'dddddddd-1000-0000-0000-000000000001' and dismiss_reason is null), 1);
  update content.opportunities set status = 'failed', dismiss_reason = 'model_refusal' where id = 'dddddddd-1000-0000-0000-000000000001';
  select pg_temp.expect('a refusal is recorded on the failed row',
    (select count(*) from content.opportunities where id = 'dddddddd-1000-0000-0000-000000000001' and dismiss_reason = 'model_refusal'), 1);
rollback;

do $$ begin
  begin
    update content.opportunities set dismiss_reason = 'bored' where id = 'dddddddd-1000-0000-0000-000000000001';
    raise exception 'FAIL an unknown dismiss reason must be rejected';
  exception when invalid_text_representation then null;
  end;
  begin
    update measure.questions set search_intent = 'comparison' where id = 'dddddddd-0000-0000-0000-000000000001';
    raise exception 'FAIL an unknown search intent must be rejected';
  exception when check_violation then null;
  end;
  begin
    update measure.questions set keyword_difficulty = 101 where id = 'dddddddd-0000-0000-0000-000000000001';
    raise exception 'FAIL a keyword difficulty above 100 must be rejected';
  exception when check_violation then null;
  end;
  begin
    update measure.questions set search_volume = -1 where id = 'dddddddd-0000-0000-0000-000000000001';
    raise exception 'FAIL a negative search volume must be rejected';
  exception when check_violation then null;
  end;
  raise notice 'ok  dismiss reasons and keyword data are checked';
end $$;

update measure.questions set search_volume = 880, keyword_difficulty = 34, search_intent = 'commercial' where id = 'dddddddd-0000-0000-0000-000000000001';
update content.opportunities set action_type = 'refresh' where id = 'dddddddd-1000-0000-0000-000000000002';
update content.content_items set pipeline_published_at = now() where id = 'dddddddd-3000-0000-0000-000000000002';

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member reads the action of its own opportunities only',
    (select count(*) from content.opportunities where action_type = 'refresh'), 0);
  select pg_temp.expect('acme member reads its own question''s keyword data',
    (select count(*) from measure.questions where search_volume = 880 and search_intent = 'commercial'), 1);
  select pg_temp.expect('acme member never reads globex''s publishing pace',
    (select count(*) from content.content_items where pipeline_published_at is not null), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('globex member reads its own refresh',
    (select count(*) from content.opportunities where action_type = 'refresh'), 1);
  select pg_temp.expect('globex member never reads acme keyword data',
    (select count(*) from measure.questions where search_volume is not null), 0);
  select pg_temp.expect('globex member reads its own publishing pace',
    (select count(*) from content.content_items where pipeline_published_at is not null), 1);
rollback;

begin;
  set local role renderer;
  do $$
  declare t text;
  declare denied boolean;
  begin
    foreach t in array array['content.opportunities', 'measure.questions', 'content.content_items'] loop
      denied := false;
      begin
        execute format('select 1 from %s limit 1', t);
      exception when insufficient_privilege then
        denied := true;
      end;
      if not denied then
        raise exception 'FAIL renderer must not read %', t;
      end if;
    end loop;
    raise notice 'ok  renderer cannot read opportunities, questions or content items';
  end $$;
rollback;

\echo 'isolation: opportunity scoring assertions passed'

-- ── 0026/0027: competitor organic gap ───────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'content' and t.typname = 'opportunity_source' and e.enumlabel = 'competitor') then
    raise exception 'FAIL content.opportunity_source competitor missing';
  end if;
  raise notice 'ok  competitor opportunity source present';
end $$;

insert into context.entities (id, org_id, type, name, aliases, domains) values
  ('eeeeeeee-2000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222222', 'competitor', 'Initech', '{}', '{initech.com}');
-- org_id deliberately wrong on the first row: the trigger takes it from the site.
insert into measure.competitor_keywords
  (site_id, org_id, entity_id, domain, keyword, question_id, rank, url, search_volume, keyword_difficulty, search_intent, brand_rank, brand_url, locale) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'eeeeeeee-2000-0000-0000-000000000002',
   'okta.com', 'scim provisioning', 'dddddddd-0000-0000-0000-000000000001', 3, 'https://www.okta.com/scim', 880, 41, 'commercial', 14, 'https://acme.com/resources/scim', 'us-en'),
  ('aaaaaaaa-0000-0000-0000-000000000001', null, 'eeeeeeee-2000-0000-0000-000000000002',
   'okta.com', 'what is sso', null, 7, 'https://www.okta.com/sso', 5400, 62, 'informational', null, null, 'us-en'),
  ('bbbbbbbb-0000-0000-0000-000000000002', null, 'eeeeeeee-2000-0000-0000-000000000009',
   'initech.com', 'widget pricing', 'dddddddd-0000-0000-0000-000000000002', 2, 'https://initech.com/pricing', 320, 18, 'transactional', null, null, 'us-en');

begin;
  select pg_temp.expect('a competitor keyword takes its org from its site',
    (select count(*) from measure.competitor_keywords where site_id = 'aaaaaaaa-0000-0000-0000-000000000001' and org_id = '11111111-1111-1111-1111-111111111111'), 2);
  delete from context.entities where id = 'eeeeeeee-2000-0000-0000-000000000009';
  select pg_temp.expect('deleting the competitor deletes its keywords',
    (select count(*) from measure.competitor_keywords where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0);
rollback;

do $$ begin
  begin
    insert into measure.competitor_keywords (site_id, entity_id, domain, keyword, rank, locale)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-2000-0000-0000-000000000009', 'initech.com', 'acme pricing', 1, 'us-en');
    raise exception 'FAIL a competitor keyword must not name another org''s competitor';
  exception when check_violation then null;
  end;
  begin
    insert into measure.competitor_keywords (site_id, entity_id, domain, keyword, question_id, rank, locale)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-2000-0000-0000-000000000002', 'okta.com', 'widget pricing',
            'dddddddd-0000-0000-0000-000000000002', 4, 'us-en');
    raise exception 'FAIL a competitor keyword must not point at another site''s question';
  exception when check_violation then null;
  end;
  begin
    update measure.competitor_keywords set site_id = 'bbbbbbbb-0000-0000-0000-000000000002' where keyword = 'what is sso';
    raise exception 'FAIL a competitor keyword must not move to another org''s site';
  exception when check_violation then null;
  end;
  begin
    insert into measure.competitor_keywords (site_id, entity_id, domain, keyword, rank, locale)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-2000-0000-0000-000000000002', 'https://www.okta.com/x', 'sso', 1, 'us-en');
    raise exception 'FAIL a competitor keyword domain must be normalised';
  exception when check_violation then null;
  end;
  begin
    insert into measure.competitor_keywords (site_id, entity_id, domain, keyword, rank, search_intent, locale)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-2000-0000-0000-000000000002', 'okta.com', 'okta vs acme', 1, 'comparison', 'us-en');
    raise exception 'FAIL an unknown search intent must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into measure.competitor_keywords (site_id, entity_id, domain, keyword, rank, locale)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-2000-0000-0000-000000000002', 'okta.com', 'sso', 0, 'us-en');
    raise exception 'FAIL a rank below 1 must be rejected';
  exception when check_violation then null;
  end;
  raise notice 'ok  competitor keyword scope and shape cannot be forged';
end $$;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  select pg_temp.expect('acme member sees own competitor keywords', (select count(*) from measure.competitor_keywords), 2);
  select pg_temp.expect('acme member sees no globex competitor keywords',
    (select count(*) from measure.competitor_keywords where site_id = 'bbbbbbbb-0000-0000-0000-000000000002'), 0);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["22222222-2222-2222-2222-222222222222"]}';
  select pg_temp.expect('globex member sees only globex competitor keywords', (select count(*) from measure.competitor_keywords), 1);
rollback;

begin;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":[],"is_staff":true}';
  select pg_temp.expect('staff sees every competitor keyword', (select count(*) from measure.competitor_keywords), 3);
rollback;

begin;
  set local role app_user;
  do $$ begin
    if (select count(*) from measure.competitor_keywords) <> 0 then
      raise exception 'FAIL competitor keywords readable without claims';
    end if;
    raise notice 'ok  absent claims see no competitor keywords';
  end $$;
rollback;

-- With the write grants in place, the table privilege check passes: what
-- refuses a member's write is RLS, which has no policy for one.
begin;
  grant insert, update, delete on measure.competitor_keywords to app_user;
  set local role app_user;
  set local request.jwt.claims = '{"org_ids":["11111111-1111-1111-1111-111111111111"]}';
  do $$
  declare
    denied boolean := false;
    touched int;
  begin
    begin
      insert into measure.competitor_keywords (site_id, entity_id, domain, keyword, rank, locale)
      values ('aaaaaaaa-0000-0000-0000-000000000001', 'eeeeeeee-2000-0000-0000-000000000002', 'okta.com', 'sso pricing', 2, 'us-en');
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL members must not write competitor keywords';
    end if;
    update measure.competitor_keywords set rank = 1;
    get diagnostics touched = row_count;
    if touched <> 0 then
      raise exception 'FAIL members must not update competitor keywords (% rows)', touched;
    end if;
    delete from measure.competitor_keywords;
    get diagnostics touched = row_count;
    if touched <> 0 then
      raise exception 'FAIL members must not delete competitor keywords (% rows)', touched;
    end if;
    raise notice 'ok  members cannot write competitor keywords, even granted the table';
  end $$;
rollback;

begin;
  set local role renderer;
  do $$
  declare denied boolean := false;
  begin
    begin
      perform 1 from measure.competitor_keywords limit 1;
    exception when insufficient_privilege then
      denied := true;
    end;
    if not denied then
      raise exception 'FAIL renderer must not read measure.competitor_keywords';
    end if;
    raise notice 'ok  renderer cannot read competitor keywords';
  end $$;
rollback;

\echo 'isolation: competitor organic gap assertions passed'
