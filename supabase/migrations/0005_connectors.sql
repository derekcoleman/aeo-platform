-- ============================================================================
-- 0005 — Connectors: Slack, Google (Search Console + GA4), Profound.
--
-- context_connections  one row per connected account/property. Holds config
--                      (channel ids, property ids) and a `secret_ref` that
--                      names a Vault secret. The row NEVER holds a token.
-- context_sync_runs    every sync — backfill, incremental, webhook-triggered,
--                      manual upload — writes one row, success or failure. A
--                      connector that fails silently for two weeks is a churn
--                      event, so the failure is a row, not a log line.
-- context_documents    ingested source material (Slack messages/threads,
--                      Profound exports…) before chunking / fact extraction.
-- ops.webhook_events   the dedupe ledger behind every /api/webhooks/* route:
--                      verify signature → insert (provider, external_id) →
--                      inngest.send → 200. Never process inline.
-- app.org_features     per-org feature flags. Profound is enrichment, never a
--                      dependency: it is off unless `connector:profound` is on,
--                      and every metric computes with it off.
-- ============================================================================

create type context.connector_provider as enum ('slack', 'google', 'profound');
create type context.connection_status  as enum ('pending', 'active', 'error', 'disabled', 'disconnected');
create type context.sync_kind          as enum ('backfill', 'incremental', 'webhook', 'upload');
create type context.sync_status        as enum ('running', 'succeeded', 'failed');

-- ── feature flags ───────────────────────────────────────────────────────────
create table app.org_features (
  org_id      uuid not null references app.organizations (id) on delete cascade,
  feature     text not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  primary key (org_id, feature)
);

create or replace function app.org_feature_enabled(p_org uuid, p_feature text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select enabled from app.org_features where org_id = p_org and feature = p_feature), false)
$$;

-- ── connections ─────────────────────────────────────────────────────────────
create table context.context_connections (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references app.organizations (id) on delete cascade,
  -- Google and Profound bind to a site (a property / a brand); Slack is org-wide.
  site_id              uuid references app.sites (id) on delete cascade,
  provider             context.connector_provider not null,
  status               context.connection_status not null default 'pending',
  enabled              boolean not null default true,
  -- Non-secret configuration only: selected channel ids, GSC property, GA4
  -- property id, ingest path. Anything a customer could see in the UI.
  config               jsonb not null default '{}'::jsonb,
  -- The scopes / channels / properties the customer explicitly opted into.
  -- Default is nothing; the sync reads only what is listed here.
  scope                jsonb not null default '[]'::jsonb,
  -- Name of the Vault secret holding the token. Never the token.
  secret_ref           text,
  external_account_id  text,    -- Slack team id, Google account email, Profound org
  external_account_name text,
  last_synced_at       timestamptz,
  last_error           text,
  created_by           uuid references app.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Defence in depth: a raw token pasted into secret_ref fails the check.
  constraint connections_secret_ref_shape check (secret_ref is null or secret_ref ~ '^vault:[a-z0-9][a-z0-9:_-]*$'),
  constraint connections_config_is_object check (jsonb_typeof(config) = 'object'),
  constraint connections_scope_is_array check (jsonb_typeof(scope) = 'array')
);
create index context_connections_org_idx on context.context_connections (org_id, provider);
create index context_connections_site_idx on context.context_connections (site_id) where site_id is not null;
create unique index context_connections_slack_team_uq
  on context.context_connections (org_id, external_account_id)
  where provider = 'slack' and status <> 'disconnected';

-- Denormalise org_id from the connection so child policies never join upward.
create or replace function context.connection_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from context.context_connections where id = new.connection_id;
  end if;
  return new;
end $$;

-- ── sync runs ───────────────────────────────────────────────────────────────
create table context.context_sync_runs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references app.organizations (id) on delete cascade,
  connection_id       uuid not null references context.context_connections (id) on delete cascade,
  kind                context.sync_kind not null,
  status              context.sync_status not null default 'running',
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  documents_ingested  int not null default 0,
  metrics_ingested    int not null default 0,
  -- Where the next incremental run picks up (Slack ts, GSC date…).
  cursor              jsonb,
  error               text,
  detail              jsonb not null default '{}'::jsonb
);
create index context_sync_runs_connection_idx on context.context_sync_runs (connection_id, started_at desc);
create index context_sync_runs_failed_idx on context.context_sync_runs (org_id, started_at desc) where status = 'failed';
create trigger context_sync_runs_org before insert on context.context_sync_runs
  for each row execute function context.connection_org_id();

-- ── documents ───────────────────────────────────────────────────────────────
create table context.context_documents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references app.organizations (id) on delete cascade,
  connection_id   uuid not null references context.context_connections (id) on delete cascade,
  site_id         uuid references app.sites (id) on delete set null,
  provider        context.connector_provider not null,
  kind            text not null,           -- slack_message | slack_thread | profound_export …
  external_id     text not null,           -- provider id: channel:ts, export row hash…
  title           text,
  text            text not null,
  content_sha256  text not null,
  -- Redaction runs before embedding; unredacted rows are never chunked.
  redacted        boolean not null default false,
  metadata        jsonb not null default '{}'::jsonb,
  source_ts       timestamptz,
  retention_until timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index context_documents_org_idx on context.context_documents (org_id, provider, source_ts desc);
create index context_documents_retention_idx on context.context_documents (retention_until) where retention_until is not null;
create trigger context_documents_org before insert on context.context_documents
  for each row execute function context.connection_org_id();

-- external_metrics was created before connections existed; wire the FK now.
alter table measure.external_metrics
  add constraint external_metrics_connection_fk
  foreign key (connection_id) references context.context_connections (id) on delete set null;

-- ── webhook ledger ──────────────────────────────────────────────────────────
create table ops.webhook_events (
  id            bigint generated always as identity primary key,
  provider      text not null,
  external_id   text not null,
  received_at   timestamptz not null default now(),
  payload       jsonb not null,
  processed_at  timestamptz,
  unique (provider, external_id)
);

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'app.org_features', 'context.context_connections', 'context.context_sync_runs',
    'context.context_documents', 'ops.webhook_events'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
  foreach t in array array[
    'app.org_features', 'context.context_connections', 'context.context_sync_runs', 'context.context_documents'
  ] loop
    execute format(
      'create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
end $$;

-- Members manage their own connections (enable / disable / choose channels).
-- The token is in Vault, so the widest thing this policy exposes is a name.
create policy tenant_write on context.context_connections for all
  using (org_id = any (app.auth_org_ids()))
  with check (org_id = any (app.auth_org_ids()));

create policy staff_read on ops.webhook_events for select using (app.auth_is_staff());

revoke all on all tables in schema context from renderer;
revoke all on all tables in schema ops from renderer;
