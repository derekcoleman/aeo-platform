-- ============================================================================
-- 0013 — Onboarding: keywords and the website-derived business profile.
--
-- app.sites.keywords        what the customer typed at project creation; each
--                           becomes a topic, and they seed demand mining.
-- app.sites.profile         the business profile extracted from a crawl of
--                           the customer's own site (name, category, products,
--                           audiences, competitors, suggested keywords).
-- app.sites.profile_status  none | queued | running | ready | failed, so the
--                           project page can show progress and a retry.
-- connector 'website'       the crawl lands in context.context_documents like
--                           any other source, so chunks, facts and retrieval
--                           see the customer's site with zero extra plumbing.
-- ============================================================================

alter type context.connector_provider add value if not exists 'website';

alter table app.sites
  add column if not exists keywords           text[] not null default '{}',
  add column if not exists profile            jsonb,
  add column if not exists profile_status     text not null default 'none',
  add column if not exists profile_error      text,
  add column if not exists profile_updated_at timestamptz;

alter table app.sites drop constraint if exists sites_profile_status_check;
alter table app.sites add constraint sites_profile_status_check
  check (profile_status in ('none', 'queued', 'running', 'ready', 'failed'));
alter table app.sites drop constraint if exists sites_profile_object_check;
alter table app.sites add constraint sites_profile_object_check
  check (profile is null or jsonb_typeof(profile) = 'object');

comment on column app.sites.keywords is 'Operator-entered keywords/topics from onboarding; each becomes a measure.topics row.';
comment on column app.sites.profile is 'Business profile extracted from the website crawl (lib/onboarding/profile.ts businessProfileSchema).';
