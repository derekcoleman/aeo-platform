-- ============================================================================
-- 0002 — render config for the least-privilege renderer role.
--
-- The renderer can read exactly one table (content.published_pages), which
-- deliberately leaves it unable to look up the site's theme, locale or prefix.
-- Rather than widen its grants across app.*, we materialise the small,
-- non-sensitive slice it needs into content, alongside the pages themselves.
--
-- This is the same "materialise at publish" shape as published_pages: a theme
-- or prefix change re-materialises, which is also exactly when caches need to
-- be invalidated anyway.
-- ============================================================================

create table content.site_render_config (
  site_id          uuid primary key references app.sites (id) on delete cascade,
  canonical_domain text not null,
  path_prefix      text not null,
  locale           text not null default 'en-US',
  trailing_slash   app.slash_mode not null default 'never',
  -- tokens + sanitised header/footer fragments + custom css
  theme            jsonb not null default '{}'::jsonb,
  organization     jsonb not null default '{}'::jsonb,  -- name, url, logo for JSON-LD
  updated_at       timestamptz not null default now()
);

alter table content.site_render_config enable row level security;
alter table content.site_render_config force row level security;

create policy tenant_read on content.site_render_config for select
  using (
    exists (
      select 1 from app.sites s
      where s.id = site_render_config.site_id
        and (s.org_id = any (app.auth_org_ids()) or app.auth_is_staff())
    )
  );

grant select on content.site_render_config to renderer;
create policy renderer_read on content.site_render_config for select
  to renderer using (true);

-- Keep the materialised copy in step with the source of truth. Theme edits go
-- through the app and re-materialise explicitly; this trigger covers the site
-- columns so they can never silently drift.
create or replace function content.sync_site_render_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into content.site_render_config
    (site_id, canonical_domain, path_prefix, locale, trailing_slash, updated_at)
  values (new.id, new.canonical_domain, new.path_prefix, new.locale, new.trailing_slash, now())
  on conflict (site_id) do update set
    canonical_domain = excluded.canonical_domain,
    path_prefix      = excluded.path_prefix,
    locale           = excluded.locale,
    trailing_slash   = excluded.trailing_slash,
    updated_at       = now();
  return new;
end $$;

create trigger sites_sync_render_config
  after insert or update of canonical_domain, path_prefix, locale, trailing_slash
  on app.sites
  for each row execute function content.sync_site_render_config();

-- A site may not claim a prefix that collides with our internal rewrite target.
alter table app.sites
  add constraint sites_path_prefix_not_reserved
  check (path_prefix <> '/render' and path_prefix not like '/render/%');
