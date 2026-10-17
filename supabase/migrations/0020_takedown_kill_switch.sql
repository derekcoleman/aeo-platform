-- ============================================================================
-- 0020 — Takedown, kill switch and one-click rollback.
--
-- content.published_pages    + status: live serves as before; noindex still
--                            serves, with a robots meta and X-Robots-Tag;
--                            retired answers 410. Only live pages are listed
--                            in the sitemap, the feed and the llms files.
--                            + version_id / previous_version_id: the version
--                            the row was built from and the one it replaced.
--                            A rollback recomposes the previous one, no model
--                            call. + status_changed_at / status_reason.
-- app.sites.indexing_paused  the owner's site-wide pause: every page serves
--                            noindex, the listings are empty, and publishing
--                            holds until it is lifted.
-- ops.autonomy_controls      staff kill switches at three scopes: the whole
--                            platform, one organisation, one site.
--                            publishing_paused holds every publish step;
--                            indexing_paused takes the scope's pages out of
--                            the index like the owner's pause.
-- content.site_render_config + indexing_paused: the effective pause (the
--                            site flag, or any control that covers the site),
--                            kept in step by trigger. The renderer reads
--                            published_pages and site_render_config only, so
--                            this needs no new grant, and it reads the row on
--                            every request, so a pause holds on the next one
--                            (a CDN may keep a copy for its 5-minute s-maxage).
-- ============================================================================

-- ── page status and versions ────────────────────────────────────────────────
create type content.page_status as enum ('live', 'noindex', 'retired');

alter table content.published_pages
  add column if not exists status              content.page_status not null default 'live',
  add column if not exists version_id          uuid references content.content_versions (id) on delete set null,
  add column if not exists previous_version_id uuid references content.content_versions (id) on delete set null,
  add column if not exists status_changed_at   timestamptz,
  add column if not exists status_reason       text;
comment on column content.published_pages.status is 'live: served and listed. noindex: served with noindex, never listed. retired: 410, never listed.';
comment on column content.published_pages.version_id is 'The content version this row was composed from.';
comment on column content.published_pages.previous_version_id is 'The version this row replaced; what a rollback republishes.';

-- Every row written so far was composed from its item's current version.
update content.published_pages p
  set version_id = i.current_version_id
  from content.content_items i
  where i.id = p.content_item_id and p.version_id is null and i.current_version_id is not null;

-- The sitemap, feed and llms queries read live pages only, newest first.
create index if not exists published_pages_live_idx
  on content.published_pages (site_id, updated_at desc) where status = 'live';

-- Deleting a content version sets these to null; without an index every
-- version deleted (a site or an item going, by cascade) scans every page.
create index if not exists published_pages_version_idx
  on content.published_pages (version_id) where version_id is not null;
create index if not exists published_pages_previous_version_idx
  on content.published_pages (previous_version_id) where previous_version_id is not null;

-- ── pause flags ─────────────────────────────────────────────────────────────
alter table app.sites
  add column if not exists indexing_paused boolean not null default false;
comment on column app.sites.indexing_paused is 'Set by an owner or admin: every page of the site serves noindex and publishing holds. The renderer reads the effective value from content.site_render_config.';

alter table content.site_render_config
  add column if not exists indexing_paused boolean not null default false;
comment on column content.site_render_config.indexing_paused is 'Effective pause: app.sites.indexing_paused or an ops.autonomy_controls row covering the site. Maintained by trigger; never written by the app.';

-- ── staff kill switches ─────────────────────────────────────────────────────
create type ops.control_scope as enum ('global', 'org', 'site');

create table ops.autonomy_controls (
  id                 uuid primary key default gen_random_uuid(),
  scope              ops.control_scope not null,
  org_id             uuid references app.organizations (id) on delete cascade,
  site_id            uuid references app.sites (id) on delete cascade,
  publishing_paused  boolean not null default false,
  indexing_paused    boolean not null default false,
  reason             text,
  set_by             uuid,
  set_at             timestamptz not null default now(),
  constraint autonomy_controls_scope_shape check (
    (scope = 'global' and org_id is null and site_id is null) or
    (scope = 'org' and org_id is not null and site_id is null) or
    (scope = 'site' and org_id is not null and site_id is not null)
  ),
  constraint autonomy_controls_one_per_scope unique nulls not distinct (scope, org_id, site_id)
);
comment on table ops.autonomy_controls is
  'Staff kill switches: one row per scope (global, an organisation, a site). Written from /ops; read by publishGuard and, through content.site_render_config, by the renderer.';

-- A site control always carries its site's org, whatever the writer passed.
create or replace function ops.control_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.site_id is not null then
    select org_id into new.org_id from app.sites where id = new.site_id;
  end if;
  return new;
end $$;

create trigger autonomy_controls_org
  before insert or update of site_id, org_id on ops.autonomy_controls
  for each row execute function ops.control_org_id();

-- ── the effective pause ─────────────────────────────────────────────────────
-- Two triggers write it: one on the controls (refresh_indexing_paused) and
-- the site's own (sync_site_render_config). Under READ COMMITTED each would
-- compute from its own snapshot, wait on the other's row lock, then write a
-- stale answer over the other's: a kill switch flipped during a site edit
-- would be lost for good. So both take this lock first and compute in the
-- statement after it, whose snapshot sees whatever the other committed.
create or replace function content.lock_indexing_paused()
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('content.indexing_paused'))
$$;

-- Is any control covering this site pausing its indexing?
create or replace function ops.indexing_paused_by_control(p_site uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from ops.autonomy_controls a
    where a.indexing_paused
      and (a.scope = 'global'
           or (a.scope = 'org' and a.org_id = p_org)
           or (a.scope = 'site' and a.site_id = p_site))
  )
$$;

-- Recompute site_render_config.indexing_paused for one site (p_site), one
-- organisation's sites (p_org), or every site (both null).
create or replace function content.refresh_indexing_paused(p_site uuid, p_org uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform content.lock_indexing_paused();
  update content.site_render_config c
    set indexing_paused = e.paused, updated_at = now()
    from (
      select s.id, (s.indexing_paused or ops.indexing_paused_by_control(s.id, s.org_id)) as paused
      from app.sites s
      where (p_site is null or s.id = p_site) and (p_org is null or s.org_id = p_org)
    ) e
    where c.site_id = e.id and c.indexing_paused is distinct from e.paused;
end $$;

create or replace function ops.autonomy_controls_refresh()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- (site, org) for a site control, (null, org) for an org, (null, null) for global.
  if tg_op <> 'INSERT' then
    perform content.refresh_indexing_paused(old.site_id, old.org_id);
  end if;
  if tg_op <> 'DELETE' then
    perform content.refresh_indexing_paused(new.site_id, new.org_id);
  end if;
  return null;
end $$;

create trigger autonomy_controls_refresh
  after insert or update or delete on ops.autonomy_controls
  for each row execute function ops.autonomy_controls_refresh();

-- 0002's materialisation, now carrying the effective pause. The column list
-- grows by indexing_paused, so the owner's flag reaches the renderer through
-- the same trigger as the domain and prefix, and a new site starts paused
-- when a global or org control is in force.
create or replace function content.sync_site_render_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform content.lock_indexing_paused();
  insert into content.site_render_config
    (site_id, canonical_domain, path_prefix, locale, trailing_slash, indexing_paused, updated_at)
  values (new.id, new.canonical_domain, new.path_prefix, new.locale, new.trailing_slash,
          new.indexing_paused or ops.indexing_paused_by_control(new.id, new.org_id), now())
  on conflict (site_id) do update set
    canonical_domain = excluded.canonical_domain,
    path_prefix      = excluded.path_prefix,
    locale           = excluded.locale,
    trailing_slash   = excluded.trailing_slash,
    indexing_paused  = excluded.indexing_paused,
    updated_at       = now();
  return new;
end $$;

drop trigger if exists sites_sync_render_config on app.sites;
create trigger sites_sync_render_config
  after insert or update of canonical_domain, path_prefix, locale, trailing_slash, indexing_paused
  on app.sites
  for each row execute function content.sync_site_render_config();

-- Only the triggers call these; nobody needs them over PostgREST.
revoke execute on function content.refresh_indexing_paused(uuid, uuid) from public;
revoke execute on function ops.indexing_paused_by_control(uuid, uuid) from public;
revoke execute on function content.lock_indexing_paused() from public;

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table ops.autonomy_controls enable row level security;
alter table ops.autonomy_controls force row level security;
create policy staff_read on ops.autonomy_controls for select using (app.auth_is_staff());

revoke all on ops.autonomy_controls from renderer;
