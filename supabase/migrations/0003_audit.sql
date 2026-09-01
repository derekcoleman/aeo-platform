-- ============================================================================
-- 0003 — AEO audit runs, findings, per-page scores, and public share links.
--
-- Append-only. gtm-agents keyed geo_audits on (session_id, target_url) and
-- overwrote on re-audit, which is why it had no trend lines. Every run here
-- is a new row; diffing is a join on audit_findings.rule_key.
--
-- org_id / site_id are nullable because the public /audit lead magnet runs
-- with no tenant. Those rows are reachable only through public_audits by
-- share slug, on the server, never through RLS as a user.
-- ============================================================================

create type app.audit_kind   as enum ('public', 'preflight', 'monitored');
create type app.audit_status as enum ('queued', 'running', 'completed', 'failed');

create table app.audit_runs (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid references app.organizations (id) on delete cascade,
  site_id                uuid references app.sites (id) on delete cascade,
  target_url             text not null,
  domain                 text not null,
  kind                   app.audit_kind   not null default 'public',
  status                 app.audit_status not null default 'queued',
  geo_score              smallint check (geo_score between 0 and 100),
  dimension_scores       jsonb,
  -- modules that failed: [{module, reason}]. Never zero-filled.
  degraded               jsonb not null default '[]'::jsonb,
  -- the full AuditResult minus page bodies; the findings/pages tables are the
  -- queryable projection of this.
  result                 jsonb,
  pages_analyzed         int not null default 0,
  duration_ms            int,
  llm_calls              int not null default 0,
  cost_usd               numeric(10, 4),
  rule_registry_version  text,
  started_at             timestamptz,
  completed_at           timestamptz,
  error                  text,
  created_at             timestamptz not null default now()
);
create index audit_runs_org_idx    on app.audit_runs (org_id, created_at desc) where org_id is not null;
create index audit_runs_site_idx   on app.audit_runs (site_id, created_at desc) where site_id is not null;
create index audit_runs_domain_idx on app.audit_runs (domain, created_at desc);

-- One row per rule that fired (or passed, for page rules). rule_key +
-- evidence per rule is what makes diffing and trend lines work.
create table app.audit_findings (
  id              uuid primary key default gen_random_uuid(),
  audit_run_id    uuid not null references app.audit_runs (id) on delete cascade,
  org_id          uuid references app.organizations (id) on delete cascade,
  rule_key        text not null,
  category        text not null,
  priority        text not null,
  passed          boolean not null default false,
  score           numeric(6, 2),
  max_score       numeric(6, 2),
  evidence        jsonb not null default '{}'::jsonb,
  recommendation  jsonb
);
create index audit_findings_run_idx  on app.audit_findings (audit_run_id);
create index audit_findings_rule_idx on app.audit_findings (rule_key, audit_run_id);

-- The per-page surface gtm-agents was missing: which page to fix.
create table app.audit_pages (
  id            uuid primary key default gen_random_uuid(),
  audit_run_id  uuid not null references app.audit_runs (id) on delete cascade,
  org_id        uuid references app.organizations (id) on delete cascade,
  url           text not null,
  title         text,
  http_status   smallint,
  -- {structure: StructureScore, citability?: number}
  scores        jsonb not null default '{}'::jsonb,
  -- top passages the model would lift, with dimension scores
  passages      jsonb,
  unique (audit_run_id, url)
);

-- Public share links. id is a short random slug; expires_at is enforced by
-- the read path (gtm-agents wrote it and never checked it).
create table app.public_audits (
  id             text primary key,
  audit_run_id   uuid not null references app.audit_runs (id) on delete cascade,
  domain         text not null,
  email          text,
  expires_at     timestamptz not null default now() + interval '30 days',
  scanned_by_ip  inet,
  created_at     timestamptz not null default now()
);
create index public_audits_domain_idx on app.public_audits (domain, created_at desc);
create index public_audits_ip_idx     on app.public_audits (scanned_by_ip, created_at desc);

-- Denormalise org_id from the run onto children so policies never join upward.
create or replace function app.audit_child_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  select org_id into new.org_id from app.audit_runs where id = new.audit_run_id;
  return new;
end $$;

create trigger audit_findings_org before insert or update of audit_run_id on app.audit_findings
  for each row execute function app.audit_child_org_id();
create trigger audit_pages_org before insert or update of audit_run_id on app.audit_pages
  for each row execute function app.audit_child_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['app.audit_runs', 'app.audit_findings', 'app.audit_pages', 'app.public_audits'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
  foreach t in array array['app.audit_runs', 'app.audit_findings', 'app.audit_pages'] loop
    -- org_id is null for public runs; null = any(...) is null, so they are
    -- invisible to every tenant, which is the intent.
    execute format(
      'create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
end $$;

-- Share links are served by the server, keyed by slug. Staff only via RLS.
create policy staff_read on app.public_audits for select using (app.auth_is_staff());

revoke all on all tables in schema app from renderer;
