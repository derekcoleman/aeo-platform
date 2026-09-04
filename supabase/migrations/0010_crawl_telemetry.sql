-- ============================================================================
-- 0010 — Crawl telemetry, bot verification, per-site proxy secret, edge alerts.
--
-- analytics.crawl_events   one row per AI-crawler hit reported by a customer's
--                          Worker (source 'worker', sees cache hits too) or
--                          observed at our origin (source 'origin', misses only)
--                          or imported from Profound (source 'profound').
-- analytics.crawl_daily    hourly rollup the dashboard reads; never the raw table.
-- ops.bots                 the bot catalogue: family, operator, purpose, and the
--                          published IP ranges used to mark a hit `verified`.
--                          A UA string alone is worthless — GPTBot is trivially
--                          spoofed — so verified and unverified are kept apart.
-- ops.site_alerts          what a customer's Worker reports back (site mismatch,
--                          loop, origin down, mirror served) — the failure modes
--                          we cannot see from our side.
-- app.sites.proxy_hmac_secret
--                          per-site shared secret. The Worker signs origin
--                          requests and telemetry with it; we verify. Readable by
--                          the org (they paste it into their Worker) and never
--                          by the renderer.
-- ============================================================================

alter table app.sites
  add column proxy_hmac_secret text not null default encode(gen_random_bytes(24), 'hex');
comment on column app.sites.proxy_hmac_secret is
  'Shared with the customer Worker at install time. Signs x-aeo-sig on proxied requests and on telemetry posts.';

create type analytics.bot_purpose as enum ('train', 'search_index', 'live_fetch', 'other');
create type analytics.crawl_source as enum ('worker', 'origin', 'profound');

-- ── bot catalogue ───────────────────────────────────────────────────────────
create table ops.bots (
  family         text primary key,                    -- 'gptbot', 'chatgpt-user', …
  operator       text not null,                       -- 'OpenAI'
  purpose        analytics.bot_purpose not null,
  ua_pattern     text not null,                       -- case-insensitive regex on the UA
  ranges_url     text,                                -- published JSON of IP prefixes, when the operator has one
  ip_ranges      cidr[] not null default '{}',
  verify_method  text not null default 'none' check (verify_method in ('ip_range', 'rdns', 'none')),
  ranges_updated_at timestamptz,
  updated_at     timestamptz not null default now()
);

insert into ops.bots (family, operator, purpose, ua_pattern, ranges_url, verify_method) values
  ('chatgpt-user',      'OpenAI',      'live_fetch',   'ChatGPT-User',      'https://openai.com/chatgpt-user.json',            'ip_range'),
  ('perplexity-user',   'Perplexity',  'live_fetch',   'Perplexity-User',   'https://www.perplexity.com/perplexity-user.json',  'ip_range'),
  ('claude-user',       'Anthropic',   'live_fetch',   'Claude-User',       null,                                               'none'),
  ('gemini-user',       'Google',      'live_fetch',   'Gemini-User',       'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json', 'ip_range'),
  ('oai-searchbot',     'OpenAI',      'search_index', 'OAI-SearchBot',     'https://openai.com/searchbot.json',                'ip_range'),
  ('perplexitybot',     'Perplexity',  'search_index', 'PerplexityBot',     'https://www.perplexity.com/perplexitybot.json',    'ip_range'),
  ('claude-searchbot',  'Anthropic',   'search_index', 'Claude-SearchBot',  null,                                               'none'),
  ('bingbot',           'Microsoft',   'search_index', 'bingbot',           'https://www.bing.com/toolbox/bingbot.json',        'ip_range'),
  ('googlebot',         'Google',      'search_index', 'Googlebot',         'https://developers.google.com/static/search/apis/ipranges/googlebot.json', 'ip_range'),
  ('gptbot',            'OpenAI',      'train',        'GPTBot',            'https://openai.com/gptbot.json',                   'ip_range'),
  ('claudebot',         'Anthropic',   'train',        'ClaudeBot',         null,                                               'none'),
  ('ccbot',             'Common Crawl','train',        'CCBot',             null,                                               'none'),
  ('google-extended',   'Google',      'train',        'Google-Extended',   'https://developers.google.com/static/search/apis/ipranges/googlebot.json', 'ip_range'),
  ('applebot-extended', 'Apple',       'train',        'Applebot-Extended', 'https://search.developer.apple.com/applebot.json', 'ip_range'),
  ('bytespider',        'ByteDance',   'train',        'Bytespider',        null,                                               'none');

-- ── raw events ──────────────────────────────────────────────────────────────
create table analytics.crawl_events (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references app.organizations (id) on delete cascade,
  site_id       uuid not null references app.sites (id) on delete cascade,
  ts            timestamptz not null,
  path          text not null,
  content_id    uuid references content.content_items (id) on delete set null,
  bot_family    text not null,
  purpose       analytics.bot_purpose not null,
  verified      boolean not null default false,
  ua_raw        text,
  ip_hash       text,                                  -- salted sha256 prefix; never the address
  country       text,
  status        int,
  cache_status  text,
  source        analytics.crawl_source not null,
  created_at    timestamptz not null default now()
);
create index crawl_events_site_ts_idx on analytics.crawl_events (site_id, ts desc);
create index crawl_events_site_purpose_idx on analytics.crawl_events (site_id, purpose, ts desc);
create trigger crawl_events_org before insert on analytics.crawl_events
  for each row execute function app.site_org_id();

-- ── daily rollup ────────────────────────────────────────────────────────────
create table analytics.crawl_daily (
  org_id         uuid not null references app.organizations (id) on delete cascade,
  site_id        uuid not null references app.sites (id) on delete cascade,
  day            date not null,
  bot_family     text not null,
  purpose        analytics.bot_purpose not null,
  source         analytics.crawl_source not null,
  path           text not null,
  hits           int not null default 0,
  verified_hits  int not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (site_id, day, bot_family, source, path)
);
create index crawl_daily_site_day_idx on analytics.crawl_daily (site_id, day desc);
create trigger crawl_daily_org before insert on analytics.crawl_daily
  for each row execute function app.site_org_id();

-- ── edge alerts ─────────────────────────────────────────────────────────────
create table ops.site_alerts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references app.organizations (id) on delete cascade,
  site_id     uuid not null references app.sites (id) on delete cascade,
  kind        text not null,                           -- site_mismatch | loop | origin_error | mirror_served | …
  path        text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint site_alerts_detail_is_object check (jsonb_typeof(detail) = 'object')
);
create index site_alerts_site_idx on ops.site_alerts (site_id, created_at desc);
create trigger site_alerts_org before insert on ops.site_alerts
  for each row execute function app.site_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['analytics.crawl_events', 'analytics.crawl_daily', 'ops.site_alerts'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
end $$;

-- The catalogue is public knowledge; every signed-in user may read it.
alter table ops.bots enable row level security;
alter table ops.bots force row level security;
create policy bots_read on ops.bots for select using (true);

revoke all on analytics.crawl_events, analytics.crawl_daily, ops.site_alerts, ops.bots from renderer;
