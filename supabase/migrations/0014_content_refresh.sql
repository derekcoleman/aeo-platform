-- ============================================================================
-- 0014 — Content refresh: the CMS inventory and the refresh loop.
--
-- content.cms_items         every item the Webflow connection can see, across
--                           every collection: which collection it lives in,
--                           when it was last modified and last published, its
--                           body, and the refresh score the nightly scan
--                           computes from Search Console traffic and AI
--                           citations (native trackers and Profound).
--                           `content_item_id` links an item we pushed there
--                           (or imported for a refresh) to our own record.
-- content.content_items     + origin: 'pipeline' for articles we wrote and
--                           serve through the proxy, 'cms' for an existing
--                           CMS post imported so the pipeline can refresh it
--                           in place. A cms-origin item is never materialised
--                           into published_pages — its home is the customer's
--                           CMS URL — and a push never changes its slug.
-- measure.external_metrics  gains the `gsc_page_window` surface: site-wide
--                           per-page totals for the current and previous
--                           28 days, unfiltered by the proxy prefix, so a
--                           Webflow post at /blog/x has traffic data too.
--                           No schema change; the surface is text.
-- ============================================================================

alter table content.content_items
  add column if not exists origin text not null default 'pipeline';
alter table content.content_items drop constraint if exists content_items_origin_check;
alter table content.content_items add constraint content_items_origin_check
  check (origin in ('pipeline', 'cms'));
comment on column content.content_items.origin is 'pipeline = written by us and served through the proxy; cms = an existing CMS post imported for refresh, published back to the CMS only.';

-- content_items predates content.site_org_id(); every other content table
-- denormalises org_id from the site on insert, and this one must too, so a
-- pipeline insert that names only the site does not hit the not-null.
drop trigger if exists content_items_org on content.content_items;
create trigger content_items_org before insert on content.content_items
  for each row execute function content.site_org_id();

-- `https://www.Acme.com/blog/x/?utm=1` → `acme.com/blog/x`. The same rule as
-- lib/refresh/inventory.ts urlKey(), so a GSC page URL, a cited URL and an
-- inventory row meet on one key regardless of scheme, www or a trailing slash.
create or replace function content.url_key(p_url text)
returns text language sql immutable set search_path = '' as $$
  select nullif(rtrim(split_part(split_part(regexp_replace(lower(p_url), '^https?://(www\.)?', ''), '?', 1), '#', 1), '/'), '')
$$;

create table content.cms_items (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references app.organizations (id) on delete cascade,
  site_id             uuid not null references app.sites (id) on delete cascade,
  connection_id       uuid not null references context.context_connections (id) on delete cascade,
  provider            text not null default 'webflow',
  external_site_id    text not null,
  collection_id       text not null,
  collection_name     text not null,
  collection_slug     text not null,
  external_id         text not null,
  slug                text,
  title               text,
  -- The public URL we believe the item lives at (site domain + collection slug + item slug),
  -- and its normalised form (scheme/www/trailing slash stripped) for joining GSC pages and citations.
  url                 text,
  url_key             text,
  body_html           text,
  summary             text,
  word_count          int not null default 0,
  heading_count       int not null default 0,
  is_draft            boolean not null default false,
  is_archived         boolean not null default false,
  created_on          timestamptz,
  last_updated        timestamptz,
  last_published      timestamptz,
  -- The slugs the connector picked for title / body / summary in this collection, so a refresh writes the same fields.
  field_map           jsonb not null default '{}'::jsonb,
  content_item_id     uuid references content.content_items (id) on delete set null,
  -- Refresh scan output: score, its breakdown and the raw signals it was computed from.
  refresh_score       numeric(6, 2),
  refresh_breakdown   jsonb,
  refresh_signals     jsonb,
  refresh_reasons     text[] not null default '{}',
  scored_at           timestamptz,
  last_refreshed_at   timestamptz,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  -- Set when a sync no longer sees the item (deleted in the CMS); kept for history.
  missing_since       timestamptz,
  updated_at          timestamptz not null default now(),
  unique (connection_id, collection_id, external_id),
  constraint cms_items_field_map_is_object check (jsonb_typeof(field_map) = 'object')
);
create index cms_items_site_idx on content.cms_items (site_id, refresh_score desc nulls last);
create index cms_items_site_collection_idx on content.cms_items (site_id, collection_id);
create index cms_items_url_key_idx on content.cms_items (site_id, url_key) where url_key is not null;
create index cms_items_content_item_idx on content.cms_items (content_item_id) where content_item_id is not null;
create trigger cms_items_org before insert on content.cms_items
  for each row execute function content.site_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table content.cms_items enable row level security;
alter table content.cms_items force row level security;
create policy tenant_read on content.cms_items for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

revoke all on content.cms_items from renderer;
