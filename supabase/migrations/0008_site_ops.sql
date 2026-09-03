-- ============================================================================
-- 0008 — Proxy onboarding + health: preflights, verification, the 5-minute
--         monitor, and the AI Crawler Access Report.
--
-- site_preflights     one row per preflight or standalone crawler report:
--                     path-collision scan of the customer's sitemap, the
--                     proxy verification probe (through THEIR edge), the CSP
--                     probe, robots.txt evaluation and the live per-bot
--                     WAF probe. Append-only; re-runs diff against the last.
-- site_health_checks  gains `kind` (monitor | verification) and `failed[]`
--                     so a transition is a query, not a jsonb dig.
-- sites               gain the consecutive-failure counter and last-known
--                     state the monitor alerts on. Customers silently break
--                     the proxy during their own infra changes; catching it
--                     in five minutes instead of five weeks is a churn issue.
-- ============================================================================

create type app.preflight_kind as enum ('preflight', 'crawler_report');
create type app.health_kind    as enum ('monitor', 'verification');

-- Denormalise org_id from the site; same shape as measure/content.site_org_id().
create or replace function app.site_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from app.sites where id = new.site_id;
  end if;
  return new;
end $$;

-- ── sites: health state ─────────────────────────────────────────────────────
alter table app.sites
  add column health_failures   int not null default 0,      -- consecutive failed checks
  add column last_health_at    timestamptz,
  add column last_health_ok    boolean,
  add column health_alerted_at timestamptz;                 -- set when the failure alert went out; cleared on recovery

-- ── health checks ───────────────────────────────────────────────────────────
alter table app.site_health_checks
  add column kind    app.health_kind not null default 'monitor',
  add column failed  text[] not null default '{}';           -- keys of the checks that failed
create index site_health_failed_idx on app.site_health_checks (site_id, checked_at desc) where not ok;

-- ── preflights ──────────────────────────────────────────────────────────────
create table app.site_preflights (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references app.organizations (id) on delete cascade,
  site_id         uuid not null references app.sites (id) on delete cascade,
  kind            app.preflight_kind not null default 'preflight',
  status          app.audit_status not null default 'queued',
  ok              boolean,
  -- PreflightResult (lib/proxy/preflight.ts): checks, blocking reasons,
  -- path collisions, robots verdicts. Kept whole so a re-run can be diffed.
  result          jsonb not null default '{}'::jsonb,
  -- CrawlerAccessReport (lib/proxy/crawler-access.ts): per-bot allow / block /
  -- challenge through the customer's edge. The pre-sale artifact.
  crawler_access  jsonb,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint preflights_result_is_object check (jsonb_typeof(result) = 'object')
);
create index site_preflights_site_idx on app.site_preflights (site_id, created_at desc);
create trigger site_preflights_org before insert on app.site_preflights
  for each row execute function app.site_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table app.site_preflights enable row level security;
alter table app.site_preflights force row level security;
create policy tenant_read on app.site_preflights for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

revoke all on app.site_preflights, app.site_health_checks from renderer;
