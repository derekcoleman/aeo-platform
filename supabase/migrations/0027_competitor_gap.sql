-- ============================================================================
-- 0027 — Competitor organic gap: the keywords a named competitor ranks for
-- in Google's organic top 10 and the site does not.
--
-- Once a month (and on demand from Strategy → Competitors) the job asks
-- DataForSEO Labs which keywords each named competitor's domain ranks for,
-- and which the site's own domain does, in the site's market
-- (lib/strategy/competitor-gap.ts). These are organic rankings from a
-- keyword database, not AI answers: they are kept here, apart from every
-- AI Overview, probe and Profound number, and never added to them.
--
-- measure.competitor_keywords  one row per gap keyword and competitor domain
--                              that ranks for it: the competitor (a
--                              context.entities competitor of the site's
--                              org) and the domain, its rank and ranking
--                              URL, the keyword's monthly volume, difficulty
--                              (0–100) and main intent, and where the site
--                              itself ranks: null when not in the top 20,
--                              11–20 when it is within striking distance (a
--                              page to improve, not a second page to write).
--                              question_id is the keyword's row in
--                              measure.questions (source competitor), which
--                              "Write about this" and the queue use. A run
--                              replaces a domain's rows only when that
--                              domain was fetched, so one failed fetch does
--                              not empty the card.
--
-- Org and site come from the site, whatever the writer passed; the
-- competitor must be the site's org's, and the question the site's.
-- Tenant-read on the denormalised org_id, revoked from the renderer.
-- ============================================================================

create table measure.competitor_keywords (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references app.organizations (id) on delete cascade,
  site_id             uuid not null references app.sites (id) on delete cascade,
  entity_id           uuid not null references context.entities (id) on delete cascade,
  domain              text not null,
  keyword             text not null,
  question_id         uuid references measure.questions (id) on delete set null,
  -- the competitor's organic rank (rank_group: organic results only)
  rank                smallint not null,
  url                 text,
  search_volume       int,
  keyword_difficulty  smallint,
  search_intent       text,
  -- the site's own rank and ranking URL, when it is in the top 20
  brand_rank          smallint,
  brand_url           text,
  -- the market the rankings are for, as measure.questions.locale ('us-en')
  locale              text not null,
  fetched_at          timestamptz not null default now(),
  unique (site_id, domain, keyword),
  constraint competitor_keywords_domain_shape check (measure.is_domain(domain)),
  constraint competitor_keywords_keyword check (length(btrim(keyword)) > 0),
  constraint competitor_keywords_rank check (rank between 1 and 100),
  constraint competitor_keywords_brand_rank check (brand_rank is null or brand_rank between 1 and 100),
  constraint competitor_keywords_volume check (search_volume is null or search_volume >= 0),
  constraint competitor_keywords_difficulty check (keyword_difficulty is null or keyword_difficulty between 0 and 100),
  constraint competitor_keywords_intent check (search_intent is null or search_intent in ('informational', 'navigational', 'commercial', 'transactional'))
);
comment on table measure.competitor_keywords is
  'Keywords a named competitor ranks for in Google''s organic top 10 that the site does not (DataForSEO Labs, monthly). Organic rankings only: never blended with AI answer data. Written by lib/strategy/competitor-gap.ts.';
create index competitor_keywords_site_volume_idx on measure.competitor_keywords (site_id, search_volume desc nulls last);
-- Deleting an entity or a question cascades or nulls here; without these it scans every row.
create index competitor_keywords_entity_idx on measure.competitor_keywords (entity_id);
create index competitor_keywords_question_idx on measure.competitor_keywords (question_id) where question_id is not null;

-- The row's org is its site's, always (measure.site_org_id() fills a missing
-- one only); the competitor must be that org's and the question that site's,
-- so a row never points across tenants.
create or replace function measure.competitor_keyword_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  select org_id into new.org_id from app.sites where id = new.site_id;
  if not exists (select 1 from context.entities e where e.id = new.entity_id and e.org_id = new.org_id) then
    raise exception 'entity % does not belong to the organisation of site %', new.entity_id, new.site_id
      using errcode = 'check_violation';
  end if;
  if new.question_id is not null
     and not exists (select 1 from measure.questions q where q.id = new.question_id and q.site_id = new.site_id) then
    raise exception 'question % does not belong to site %', new.question_id, new.site_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger competitor_keywords_scope
  before insert or update of site_id, org_id, entity_id, question_id on measure.competitor_keywords
  for each row execute function measure.competitor_keyword_scope();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table measure.competitor_keywords enable row level security;
alter table measure.competitor_keywords force row level security;
create policy tenant_read on measure.competitor_keywords for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

revoke all on measure.competitor_keywords from renderer;
