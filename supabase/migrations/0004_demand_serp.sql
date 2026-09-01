-- ============================================================================
-- 0004 — Demand mining and SERP / AI Overview citation tracking.
--
-- questions       the per-site question graph (autocomplete, PAA, GSC, manual…)
-- serp_snapshots  one row per (question, provider, fetch): AIO triggered? raw?
-- serp_citations  every cited URL per snapshot, by surface, with is_owned and
--                 the content_id join that closes the loop to a published asset
-- question_clusters, external_metrics (GSC / GA4 / Profound in one shape),
-- serp_cache (day-grained response cache) and serp_spend (the cost ledger the
-- per-org budget guard reads).
--
-- `provider` is on every snapshot: AIO detection rates differ by vendor and a
-- silent swap must be visible in the time series, not mistaken for a change
-- in the customer's visibility.
-- ============================================================================

create extension if not exists vector;

create type measure.question_source  as enum ('autocomplete', 'paa', 'gsc', 'gong', 'manual', 'competitor', 'profound');
create type measure.tracking_tier    as enum ('daily', 'weekly', 'monthly', 'none');
create type measure.serp_provider    as enum ('dataforseo', 'serpapi', 'profound');
create type measure.citation_surface as enum ('ai_overview', 'featured_snippet', 'organic', 'paa');

-- Per-org monthly SERP spend ceiling, enforced by the client before each call.
alter table app.organizations add column serp_monthly_budget_usd numeric(10, 2) not null default 25.00;

-- Denormalise org_id from the site so policies never join upward.
create or replace function measure.site_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from app.sites where id = new.site_id;
  end if;
  return new;
end $$;

create table measure.question_clusters (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references app.organizations (id) on delete cascade,
  site_id             uuid not null references app.sites (id) on delete cascade,
  name                text not null,
  pillar_content_id   uuid references content.content_items (id) on delete set null,
  embedding           vector(1536),
  embedding_model     text,
  question_count      int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index question_clusters_site_idx on measure.question_clusters (site_id);
create trigger question_clusters_org before insert on measure.question_clusters
  for each row execute function measure.site_org_id();

create table measure.questions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references app.organizations (id) on delete cascade,
  site_id             uuid not null references app.sites (id) on delete cascade,
  text                text not null,
  normalized          text not null,
  source              measure.question_source not null,
  seed_term           text,
  parent_question_id  uuid references measure.questions (id) on delete set null,
  depth               smallint not null default 1,
  locale              text not null default 'us-en',
  device              text not null default 'desktop',
  entity_ids          uuid[] not null default '{}',
  cluster_id          uuid references measure.question_clusters (id) on delete set null,
  embedding           vector(1536),
  embedding_model     text,
  demand_score        numeric(8, 2) not null default 0,
  -- pulled by the PAA block when Google showed one; the answer to beat
  paa_answer          jsonb,
  is_tracked          boolean not null default false,
  tracking_tier       measure.tracking_tier not null default 'none',
  seen_count          int not null default 1,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  unique (site_id, normalized, locale, device),
  constraint questions_device check (device in ('desktop', 'mobile'))
);
create index questions_site_demand_idx  on measure.questions (site_id, demand_score desc);
create index questions_tracked_idx      on measure.questions (tracking_tier, site_id) where is_tracked;
create index questions_cluster_idx      on measure.questions (cluster_id) where cluster_id is not null;
create index questions_embedding_idx    on measure.questions using hnsw (embedding vector_cosine_ops);
create trigger questions_org before insert on measure.questions
  for each row execute function measure.site_org_id();

create table measure.serp_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid references app.organizations (id) on delete cascade,
  site_id               uuid not null references app.sites (id) on delete cascade,
  question_id           uuid not null references measure.questions (id) on delete cascade,
  provider              measure.serp_provider not null,
  fetched_at            timestamptz not null default now(),
  locale                text not null,
  device                text not null,
  -- null = this provider could not report on AI Overviews for this fetch
  aio_triggered         boolean,
  aio_text              text,
  featured_snippet_url  text,
  organic_count         smallint not null default 0,
  cached                boolean not null default false,
  raw                   jsonb,
  cost_usd              numeric(10, 5) not null default 0
);
create index serp_snapshots_question_idx on measure.serp_snapshots (question_id, fetched_at desc);
create index serp_snapshots_site_idx     on measure.serp_snapshots (site_id, fetched_at desc);
create trigger serp_snapshots_org before insert on measure.serp_snapshots
  for each row execute function measure.site_org_id();

-- One table answers "who owns the AI Overview", "who owns the featured
-- snippet" and "who ranks". is_owned + content_id is the join back to a
-- specific published asset.
create table measure.serp_citations (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references app.organizations (id) on delete cascade,
  site_id           uuid not null references app.sites (id) on delete cascade,
  serp_snapshot_id  uuid not null references measure.serp_snapshots (id) on delete cascade,
  surface           measure.citation_surface not null,
  url               text not null,
  domain            text not null,
  position          smallint not null,
  is_owned          boolean not null default false,
  content_id        uuid references content.content_items (id) on delete set null,
  -- entities land with the brand brain; no FK yet so this migration stands alone
  entity_id         uuid,
  title             text,
  snippet           text
);
create index serp_citations_snapshot_idx on measure.serp_citations (serp_snapshot_id);
create index serp_citations_site_domain_idx on measure.serp_citations (site_id, surface, domain);
create index serp_citations_owned_idx on measure.serp_citations (site_id, content_id) where is_owned;
create trigger serp_citations_org before insert on measure.serp_citations
  for each row execute function measure.site_org_id();

-- Connector-sourced metrics in one shape (GSC query/page, GA4 AI referrals,
-- Profound visibility) so attribution reads three signals from one table.
create table measure.external_metrics (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid references app.organizations (id) on delete cascade,
  site_id        uuid not null references app.sites (id) on delete cascade,
  connection_id  uuid,
  provider       text not null,   -- gsc | ga4 | profound
  surface        text not null,   -- gsc_query | gsc_page | ga4_referral | profound_visibility …
  dimension      jsonb not null default '{}'::jsonb,
  date           date not null,
  metrics        jsonb not null default '{}'::jsonb,
  content_id     uuid references content.content_items (id) on delete set null,
  question_id    uuid references measure.questions (id) on delete set null,
  fetched_at     timestamptz not null default now(),
  unique (site_id, provider, surface, dimension, date)
);
create index external_metrics_site_date_idx on measure.external_metrics (site_id, provider, surface, date desc);
create trigger external_metrics_org before insert on measure.external_metrics
  for each row execute function measure.site_org_id();

-- Response cache keyed by (provider, method, query, locale, device, day).
-- Server-only; not tenant data, but query text can reveal a tenant's seed
-- terms so it is staff-readable only.
create table measure.serp_cache (
  key         text primary key,
  provider    measure.serp_provider not null,
  method      text not null,
  query       text not null,
  locale      text not null,
  device      text not null,
  day         date not null,
  payload     jsonb not null,
  cost_usd    numeric(10, 5) not null default 0,
  fetched_at  timestamptz not null default now()
);
create index serp_cache_day_idx on measure.serp_cache (day);

-- Append-only spend ledger. The budget guard sums the month's non-cached rows.
create table measure.serp_spend (
  id        bigint generated always as identity primary key,
  org_id    uuid not null references app.organizations (id) on delete cascade,
  site_id   uuid references app.sites (id) on delete set null,
  provider  measure.serp_provider not null,
  method    text not null,
  query     text not null,
  cost_usd  numeric(10, 5) not null default 0,
  cached    boolean not null default false,
  at        timestamptz not null default now()
);
create index serp_spend_org_month_idx on measure.serp_spend (org_id, at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'measure.question_clusters', 'measure.questions', 'measure.serp_snapshots',
    'measure.serp_citations', 'measure.external_metrics', 'measure.serp_cache', 'measure.serp_spend'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
  foreach t in array array[
    'measure.question_clusters', 'measure.questions', 'measure.serp_snapshots',
    'measure.serp_citations', 'measure.external_metrics', 'measure.serp_spend'
  ] loop
    execute format(
      'create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
end $$;

-- Members may curate their own question graph (track / untrack, add manual questions).
create policy tenant_write on measure.questions for all
  using (org_id = any (app.auth_org_ids()))
  with check (org_id = any (app.auth_org_ids()));

create policy staff_read on measure.serp_cache for select using (app.auth_is_staff());

revoke all on all tables in schema measure from renderer;
