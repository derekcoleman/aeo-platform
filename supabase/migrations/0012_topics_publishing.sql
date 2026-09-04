-- ============================================================================
-- 0012 — Topics, prompt control, competitor pages, publish targets.
--
-- measure.topics              what a site chooses to be known for: priority,
--                             cadence, preferred formats, seed terms and the
--                             competitors to watch. Questions and opportunities
--                             hang off a topic; scoring respects its priority.
-- measure.questions           + topic_id, pinned, excluded. "Excluded" removes a
--                             question from scanning and briefs without deleting
--                             the history behind it.
-- measure.competitor_pages    pages currently cited for a topic, fetched and
--                             scored with the shared rule registry, classified
--                             by content type — the structural target a brief
--                             must beat.
-- content.publish_targets     where a site's content goes besides the proxy:
--                             a Webflow collection with a field map.
-- content.external_publications
--                             one row per (target, item): the external id, the
--                             URL, the last push state. Re-push updates in place.
-- ============================================================================

-- ── connector providers ─────────────────────────────────────────────────────
alter type context.connector_provider add value if not exists 'webflow';

-- ── topics ──────────────────────────────────────────────────────────────────
create type measure.topic_status as enum ('active', 'paused', 'archived');

create table measure.topics (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references app.organizations (id) on delete cascade,
  site_id            uuid not null references app.sites (id) on delete cascade,
  name               text not null,
  slug               text not null,
  description        text,
  status             measure.topic_status not null default 'active',
  priority           smallint not null default 3 check (priority between 1 and 5),   -- 5 = most important
  cadence_per_month  smallint not null default 2 check (cadence_per_month between 0 and 30),
  formats            text[] not null default '{}',                                   -- comparison | howto | guide | listicle | faq
  seed_terms         text[] not null default '{}',
  competitor_domains text[] not null default '{}',
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (site_id, slug),
  constraint topics_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]*$')
);
create index topics_site_idx on measure.topics (site_id, status, priority desc);
create trigger topics_org before insert on measure.topics
  for each row execute function measure.site_org_id();

alter table measure.questions
  add column topic_id  uuid references measure.topics (id) on delete set null,
  add column pinned    boolean not null default false,
  add column excluded  boolean not null default false;
create index questions_topic_idx on measure.questions (topic_id) where topic_id is not null;

alter table content.opportunities
  add column topic_id  uuid references measure.topics (id) on delete set null,
  add column format    text check (format is null or format in ('comparison', 'howto', 'guide', 'listicle', 'faq'));
create index opportunities_topic_idx on content.opportunities (topic_id) where topic_id is not null;

-- ── competitor pages ────────────────────────────────────────────────────────
create table measure.competitor_pages (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  site_id          uuid not null references app.sites (id) on delete cascade,
  topic_id         uuid references measure.topics (id) on delete set null,
  url              text not null,
  domain           text not null,
  title            text,
  content_type     text not null default 'unknown'
                   check (content_type in ('comparison', 'howto', 'guide', 'listicle', 'faq', 'product', 'news', 'unknown')),
  word_count       int not null default 0,
  structure_score  jsonb,                                  -- StructureScore from lib/aeo/rules
  headings         jsonb not null default '[]'::jsonb,     -- ["H2 …", …]
  citations_30d    int not null default 0,                 -- how often it was cited in the last 30 days
  last_cited_at    timestamptz,
  fetch_status     int,
  fetch_error      text,
  fetched_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (site_id, url)
);
create index competitor_pages_site_idx on measure.competitor_pages (site_id, citations_30d desc);
create index competitor_pages_topic_idx on measure.competitor_pages (topic_id) where topic_id is not null;
create trigger competitor_pages_org before insert on measure.competitor_pages
  for each row execute function measure.site_org_id();

-- ── publish targets ─────────────────────────────────────────────────────────
create type content.publish_target_kind as enum ('proxy', 'webflow');
create type content.external_publication_status as enum ('pending', 'published', 'failed', 'removed');

create table content.publish_targets (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid references app.organizations (id) on delete cascade,
  site_id        uuid not null references app.sites (id) on delete cascade,
  kind           content.publish_target_kind not null,
  connection_id  uuid references context.context_connections (id) on delete set null,
  name           text not null,
  -- { siteId, siteName, collectionId, collectionName, fieldMap: {name, slug, body, summary, image, publishedAt, canonical}, publishLive, canonicalMode }
  config         jsonb not null default '{}'::jsonb,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint publish_targets_config_is_object check (jsonb_typeof(config) = 'object')
);
create index publish_targets_site_idx on content.publish_targets (site_id, enabled);
create trigger publish_targets_org before insert on content.publish_targets
  for each row execute function content.site_org_id();

create table content.external_publications (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  site_id          uuid not null references app.sites (id) on delete cascade,
  content_item_id  uuid not null references content.content_items (id) on delete cascade,
  target_id        uuid not null references content.publish_targets (id) on delete cascade,
  status           content.external_publication_status not null default 'pending',
  external_id      text,
  external_url     text,
  version_id       uuid references content.content_versions (id) on delete set null,
  payload_hash     text,
  last_error       text,
  attempts         int not null default 0,
  published_at     timestamptz,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (target_id, content_item_id)
);
create index external_publications_item_idx on content.external_publications (content_item_id);
create trigger external_publications_org before insert on content.external_publications
  for each row execute function content.site_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['measure.topics', 'measure.competitor_pages', 'content.publish_targets', 'content.external_publications'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
end $$;

create policy tenant_write on measure.topics for all
  using (org_id = any (app.auth_org_ids())) with check (org_id = any (app.auth_org_ids()));
create policy tenant_write on content.publish_targets for all
  using (app.auth_is_org_admin(org_id)) with check (app.auth_is_org_admin(org_id));

revoke all on measure.topics, measure.competitor_pages, content.publish_targets, content.external_publications from renderer;
