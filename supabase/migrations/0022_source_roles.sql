-- ============================================================================
-- 0022 — Source roles: named competitors, and the sites that shape answers
-- without competing.
--
-- "Who gets cited instead of us" counted every non-owned domain as a
-- competitor, so Reddit, G2 and Wikipedia sat next to the customer's actual
-- rivals and drove the queue's scores. Every citation now carries a role.
--
-- context.entities              + domains: a competitor's sites. A domain
--                               and its subdomains count as that competitor.
-- measure.source_role           owned | competitor | ugc_forum | video |
--                               professional_social | review_platform |
--                               reference_wiki | publisher_editorial |
--                               analyst | partner_marketplace | directory |
--                               vendor_other | unknown.
-- measure.source_domains        the global catalogue: a domain's role for
--                               everyone (reddit.com → ugc_forum). Seeded
--                               here from lib/measure/source-roles.ts
--                               SEED_SOURCE_ROLES (a test fails if the two
--                               drift); classified_by records whether a row
--                               is the seed's, a person's or a classifier's.
--                               Readable by every signed-in user, like
--                               ops.bots.
-- measure.site_source_overrides one site's own call on a domain, which beats
--                               the catalogue and the competitor list.
-- measure.serp_citations        + source_role, set by the writers
--                               (lib/demand/store.ts recordSnapshot, the
--                               Profound ingest) and, when a writer leaves it
--                               out, by a trigger; entity_id names the
--                               competitor of a competitor row.
--
-- measure.classify_source(site, domain) is the precedence, the same as
-- lib/measure/source-roles.ts classifySource: owned, then the site's
-- override, then the org's competitor domains, then the catalogue, else
-- unknown; within a tier the longest matching domain wins.
-- measure.seed_competitor_domains(org, domains) turns a topic's watched
-- domains into competitors: each joins the one competitor entity whose name
-- it spells (okta.com → "Okta") or becomes an unconfirmed competitor named
-- after the domain, which a person confirms on the Strategy page. A domain
-- the catalogue lists as anything but a vendor is skipped (a review site
-- watched as a rival stays a review site until someone names it), and so
-- are the org's own, a competitor's (or a subdomain of one), one whose
-- entity someone said is not a competitor and one an entity of another kind
-- is named after (an integration called slack.com stays an integration).
-- Only what landed on a competitor is returned. Every topic's domains go through
-- it here, every existing citation is backfilled with its role, and pages
-- analysed on sites that are no longer targets are dropped.
-- ============================================================================

-- ── domains ─────────────────────────────────────────────────────────────────
-- `https://WWW.Okta.com:443/blog` → `okta.com`. The same rule as
-- normalizeDomain() in lib/measure/source-roles.ts.
create or replace function measure.normalize_domain(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(regexp_replace(
    split_part(split_part(split_part(regexp_replace(lower(btrim(p)), '^[a-z][a-z0-9+.-]*://', ''), '/', 1), '?', 1), '#', 1),
    ':[0-9]+$', ''), '^www\.|\.$', '', 'g'), '')
$$;

-- A normalised hostname of two labels or more.
create or replace function measure.is_domain(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and length(p) <= 253 and p !~ '^www\.'
     and p ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
$$;

create or replace function measure.is_domain_list(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(bool_and(measure.is_domain(d)), true) from unnest(p) as d
$$;

-- `a.b.example.com` → {a.b.example.com, b.example.com, example.com}: what a
-- listed domain can match, longest first.
create or replace function measure.domain_suffixes(p text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(array_to_string(l.labels[i:], '.') order by i), '{}')
  from (select string_to_array(p, '.') as labels) l, generate_subscripts(l.labels, 1) as i
  where cardinality(l.labels) - i >= 1
$$;

-- ── competitor domains ──────────────────────────────────────────────────────
alter table context.entities add column if not exists domains text[] not null default '{}';
alter table context.entities add constraint entities_domains_shape check (measure.is_domain_list(domains));
comment on column context.entities.domains is 'A competitor''s sites, normalised (no scheme, www or path). A cited domain equal to one, or under it, counts as this competitor.';
create index if not exists entities_domains_idx on context.entities using gin (domains);

-- ── roles ───────────────────────────────────────────────────────────────────
create type measure.source_role as enum (
  'owned', 'competitor', 'ugc_forum', 'video', 'professional_social', 'review_platform',
  'reference_wiki', 'publisher_editorial', 'analyst', 'partner_marketplace', 'directory',
  'vendor_other', 'unknown'
);

create table measure.source_domains (
  domain         text primary key,
  role           measure.source_role not null,
  classified_by  text not null default 'seed',
  confidence     numeric(4, 3) not null default 1,
  updated_at     timestamptz not null default now(),
  constraint source_domains_shape check (measure.is_domain(domain)),
  -- Owned and competitor depend on the site; unknown is the absence of a row.
  constraint source_domains_role_check check (role not in ('owned', 'competitor', 'unknown')),
  constraint source_domains_classified_by_check check (classified_by in ('seed', 'human', 'llm')),
  constraint source_domains_confidence_check check (confidence >= 0 and confidence <= 1)
);
comment on table measure.source_domains is
  'What kind of site a domain is, for every customer: forums, video, social, review platforms, reference, publishers, analysts, marketplaces, directories, other vendors. Seeded from lib/measure/source-roles.ts.';

insert into measure.source_domains (domain, role) values
  -- ugc_forum
  ('reddit.com', 'ugc_forum'), ('quora.com', 'ugc_forum'), ('stackoverflow.com', 'ugc_forum'),
  ('stackexchange.com', 'ugc_forum'), ('superuser.com', 'ugc_forum'), ('serverfault.com', 'ugc_forum'),
  ('askubuntu.com', 'ugc_forum'), ('mathoverflow.net', 'ugc_forum'), ('news.ycombinator.com', 'ugc_forum'),
  ('github.com', 'ugc_forum'), ('gitlab.com', 'ugc_forum'), ('dev.to', 'ugc_forum'),
  ('indiehackers.com', 'ugc_forum'), ('spiceworks.com', 'ugc_forum'), ('slashdot.org', 'ugc_forum'),
  ('experts-exchange.com', 'ugc_forum'), ('answers.com', 'ugc_forum'), ('lobste.rs', 'ugc_forum'),
  ('zhihu.com', 'ugc_forum'), ('answers.microsoft.com', 'ugc_forum'),
  ('techcommunity.microsoft.com', 'ugc_forum'), ('community.atlassian.com', 'ugc_forum'),
  ('community.hubspot.com', 'ugc_forum'), ('community.shopify.com', 'ugc_forum'),
  ('community.cloudflare.com', 'ugc_forum'), ('groups.google.com', 'ugc_forum'),
  -- video
  ('youtube.com', 'video'), ('youtu.be', 'video'), ('vimeo.com', 'video'), ('tiktok.com', 'video'),
  ('twitch.tv', 'video'), ('dailymotion.com', 'video'), ('loom.com', 'video'), ('rumble.com', 'video'),
  ('ted.com', 'video'),
  -- professional_social
  ('linkedin.com', 'professional_social'), ('lnkd.in', 'professional_social'),
  ('x.com', 'professional_social'), ('twitter.com', 'professional_social'),
  ('facebook.com', 'professional_social'), ('instagram.com', 'professional_social'),
  ('threads.net', 'professional_social'), ('bsky.app', 'professional_social'),
  ('mastodon.social', 'professional_social'), ('pinterest.com', 'professional_social'),
  -- review_platform
  ('g2.com', 'review_platform'), ('g2crowd.com', 'review_platform'), ('capterra.com', 'review_platform'),
  ('capterra.co.uk', 'review_platform'), ('trustradius.com', 'review_platform'),
  ('getapp.com', 'review_platform'), ('softwareadvice.com', 'review_platform'),
  ('trustpilot.com', 'review_platform'), ('peerspot.com', 'review_platform'),
  ('sitejabber.com', 'review_platform'), ('yelp.com', 'review_platform'),
  ('tripadvisor.com', 'review_platform'), ('glassdoor.com', 'review_platform'),
  ('saasworthy.com', 'review_platform'), ('softwaresuggest.com', 'review_platform'),
  ('crozdesk.com', 'review_platform'), ('featuredcustomers.com', 'review_platform'),
  ('financesonline.com', 'review_platform'), ('selecthub.com', 'review_platform'),
  ('itqlick.com', 'review_platform'), ('comparably.com', 'review_platform'),
  ('sourceforge.net', 'review_platform'), ('clutch.co', 'review_platform'),
  ('goodfirms.co', 'review_platform'), ('consumeraffairs.com', 'review_platform'),
  ('reviews.io', 'review_platform'), ('bbb.org', 'review_platform'), ('softwareworld.co', 'review_platform'),
  ('techjockey.com', 'review_platform'),
  -- reference_wiki
  ('wikipedia.org', 'reference_wiki'), ('wikimedia.org', 'reference_wiki'),
  ('wikidata.org', 'reference_wiki'), ('wiktionary.org', 'reference_wiki'),
  ('wikihow.com', 'reference_wiki'), ('fandom.com', 'reference_wiki'), ('britannica.com', 'reference_wiki'),
  ('investopedia.com', 'reference_wiki'), ('merriam-webster.com', 'reference_wiki'),
  ('dictionary.com', 'reference_wiki'), ('dictionary.cambridge.org', 'reference_wiki'),
  ('whatis.techtarget.com', 'reference_wiki'), ('developer.mozilla.org', 'reference_wiki'),
  ('w3schools.com', 'reference_wiki'), ('techopedia.com', 'reference_wiki'),
  ('schema.org', 'reference_wiki'), ('ietf.org', 'reference_wiki'), ('rfc-editor.org', 'reference_wiki'),
  ('w3.org', 'reference_wiki'),
  -- publisher_editorial
  ('forbes.com', 'publisher_editorial'), ('techcrunch.com', 'publisher_editorial'),
  ('theverge.com', 'publisher_editorial'), ('wired.com', 'publisher_editorial'),
  ('zdnet.com', 'publisher_editorial'), ('cnet.com', 'publisher_editorial'),
  ('venturebeat.com', 'publisher_editorial'), ('businessinsider.com', 'publisher_editorial'),
  ('nytimes.com', 'publisher_editorial'), ('wsj.com', 'publisher_editorial'),
  ('bloomberg.com', 'publisher_editorial'), ('reuters.com', 'publisher_editorial'),
  ('ft.com', 'publisher_editorial'), ('theguardian.com', 'publisher_editorial'),
  ('bbc.com', 'publisher_editorial'), ('bbc.co.uk', 'publisher_editorial'),
  ('cnbc.com', 'publisher_editorial'), ('fortune.com', 'publisher_editorial'),
  ('inc.com', 'publisher_editorial'), ('entrepreneur.com', 'publisher_editorial'),
  ('fastcompany.com', 'publisher_editorial'), ('hbr.org', 'publisher_editorial'),
  ('axios.com', 'publisher_editorial'), ('theinformation.com', 'publisher_editorial'),
  ('techradar.com', 'publisher_editorial'), ('pcmag.com', 'publisher_editorial'),
  ('arstechnica.com', 'publisher_editorial'), ('engadget.com', 'publisher_editorial'),
  ('mashable.com', 'publisher_editorial'), ('infoworld.com', 'publisher_editorial'),
  ('computerworld.com', 'publisher_editorial'), ('cio.com', 'publisher_editorial'),
  ('csoonline.com', 'publisher_editorial'), ('networkworld.com', 'publisher_editorial'),
  ('techtarget.com', 'publisher_editorial'), ('informationweek.com', 'publisher_editorial'),
  ('siliconangle.com', 'publisher_editorial'), ('thenextweb.com', 'publisher_editorial'),
  ('techrepublic.com', 'publisher_editorial'), ('theregister.com', 'publisher_editorial'),
  ('geekwire.com', 'publisher_editorial'), ('thenewstack.io', 'publisher_editorial'),
  ('darkreading.com', 'publisher_editorial'), ('securityweek.com', 'publisher_editorial'),
  ('bleepingcomputer.com', 'publisher_editorial'), ('helpnetsecurity.com', 'publisher_editorial'),
  ('scmagazine.com', 'publisher_editorial'), ('searchengineland.com', 'publisher_editorial'),
  ('searchenginejournal.com', 'publisher_editorial'), ('medium.com', 'publisher_editorial'),
  ('substack.com', 'publisher_editorial'), ('hackernoon.com', 'publisher_editorial'),
  ('smashingmagazine.com', 'publisher_editorial'), ('css-tricks.com', 'publisher_editorial'),
  ('usatoday.com', 'publisher_editorial'), ('washingtonpost.com', 'publisher_editorial'),
  ('cnn.com', 'publisher_editorial'), ('apnews.com', 'publisher_editorial'),
  ('economist.com', 'publisher_editorial'), ('time.com', 'publisher_editorial'),
  ('newsweek.com', 'publisher_editorial'), ('marketwatch.com', 'publisher_editorial'),
  ('yahoo.com', 'publisher_editorial'), ('msn.com', 'publisher_editorial'),
  ('businessnewsdaily.com', 'publisher_editorial'), ('lifewire.com', 'publisher_editorial'),
  ('digitaltrends.com', 'publisher_editorial'), ('tomsguide.com', 'publisher_editorial'),
  ('tomshardware.com', 'publisher_editorial'), ('makeuseof.com', 'publisher_editorial'),
  ('howtogeek.com', 'publisher_editorial'), ('nerdwallet.com', 'publisher_editorial'),
  ('bankrate.com', 'publisher_editorial'), ('healthline.com', 'publisher_editorial'),
  ('webmd.com', 'publisher_editorial'), ('prnewswire.com', 'publisher_editorial'),
  ('businesswire.com', 'publisher_editorial'), ('globenewswire.com', 'publisher_editorial'),
  -- analyst
  ('gartner.com', 'analyst'), ('forrester.com', 'analyst'), ('idc.com', 'analyst'),
  ('mckinsey.com', 'analyst'), ('bcg.com', 'analyst'), ('bain.com', 'analyst'), ('deloitte.com', 'analyst'),
  ('statista.com', 'analyst'), ('cbinsights.com', 'analyst'), ('everestgrp.com', 'analyst'),
  ('omdia.com', 'analyst'), ('nucleusresearch.com', 'analyst'), ('hfsresearch.com', 'analyst'),
  ('isg-one.com', 'analyst'), ('frost.com', 'analyst'), ('pewresearch.org', 'analyst'),
  ('emarketer.com', 'analyst'),
  -- partner_marketplace
  ('appexchange.salesforce.com', 'partner_marketplace'),
  ('marketplace.atlassian.com', 'partner_marketplace'), ('apps.shopify.com', 'partner_marketplace'),
  ('ecosystem.hubspot.com', 'partner_marketplace'), ('appsource.microsoft.com', 'partner_marketplace'),
  ('azuremarketplace.microsoft.com', 'partner_marketplace'),
  ('marketplace.microsoft.com', 'partner_marketplace'), ('apps.apple.com', 'partner_marketplace'),
  ('play.google.com', 'partner_marketplace'), ('chromewebstore.google.com', 'partner_marketplace'),
  ('marketplace.visualstudio.com', 'partner_marketplace'), ('marketplace.zoom.us', 'partner_marketplace'),
  ('marketplace.digitalocean.com', 'partner_marketplace'), ('appsumo.com', 'partner_marketplace'),
  -- directory
  ('crunchbase.com', 'directory'), ('zoominfo.com', 'directory'), ('yellowpages.com', 'directory'),
  ('manta.com', 'directory'), ('dnb.com', 'directory'), ('owler.com', 'directory'),
  ('pitchbook.com', 'directory'), ('wellfound.com', 'directory'), ('angel.co', 'directory'),
  ('builtwith.com', 'directory'), ('similarweb.com', 'directory'), ('stackshare.io', 'directory'),
  ('producthunt.com', 'directory'), ('alternativeto.net', 'directory'), ('saashub.com', 'directory'),
  ('tracxn.com', 'directory'), ('craft.co', 'directory'), ('rocketreach.co', 'directory'),
  ('themanifest.com', 'directory'), ('designrush.com', 'directory'), ('upcity.com', 'directory'),
  ('sortlist.com', 'directory'), ('betalist.com', 'directory'), ('f6s.com', 'directory'),
  ('ycombinator.com', 'directory'), ('indeed.com', 'directory'), ('theorg.com', 'directory'),
  -- vendor_other
  ('microsoft.com', 'vendor_other'), ('google.com', 'vendor_other'), ('apple.com', 'vendor_other'),
  ('aws.amazon.com', 'vendor_other'), ('ibm.com', 'vendor_other'), ('oracle.com', 'vendor_other'),
  ('sap.com', 'vendor_other'), ('salesforce.com', 'vendor_other'), ('adobe.com', 'vendor_other'),
  ('cisco.com', 'vendor_other'), ('cloudflare.com', 'vendor_other'), ('atlassian.com', 'vendor_other'),
  ('hubspot.com', 'vendor_other'), ('zapier.com', 'vendor_other'), ('shopify.com', 'vendor_other'),
  ('stripe.com', 'vendor_other'), ('twilio.com', 'vendor_other'), ('mozilla.org', 'vendor_other'),
  ('intuit.com', 'vendor_other'), ('servicenow.com', 'vendor_other'), ('workday.com', 'vendor_other'),
  ('zendesk.com', 'vendor_other'), ('slack.com', 'vendor_other'), ('dropbox.com', 'vendor_other'),
  ('zoom.us', 'vendor_other'), ('docker.com', 'vendor_other'), ('digitalocean.com', 'vendor_other'),
  ('vercel.com', 'vendor_other'), ('netlify.com', 'vendor_other'), ('wordpress.org', 'vendor_other');

create table measure.site_source_overrides (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references app.organizations (id) on delete cascade,
  site_id     uuid not null references app.sites (id) on delete cascade,
  domain      text not null,
  role        measure.source_role not null,
  set_by      uuid references app.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (site_id, domain),
  constraint site_source_overrides_shape check (measure.is_domain(domain)),
  -- Owned follows the site's domains; a competitor is an entity with domains and aliases.
  constraint site_source_overrides_role_check check (role not in ('owned', 'competitor'))
);
comment on table measure.site_source_overrides is
  'A site''s own role for a domain (and its subdomains), set on the Strategy page. Beats the competitor list and the catalogue.';
-- An override always carries its site's org, whatever the writer passed:
-- members write this table, and measure.site_org_id() fills a missing org
-- only, so a member could otherwise file a row under their own org against
-- another org's site (or move one there) and steer that site's roles.
create or replace function measure.override_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  select org_id into new.org_id from app.sites where id = new.site_id;
  return new;
end $$;

create trigger site_source_overrides_org
  before insert or update of site_id, org_id on measure.site_source_overrides
  for each row execute function measure.override_org_id();
create index site_source_overrides_set_by_idx on measure.site_source_overrides (set_by) where set_by is not null;

-- ── classification ──────────────────────────────────────────────────────────
create or replace function measure.classify_source(p_site_id uuid, p_domain text)
returns table (role measure.source_role, entity_id uuid)
language sql stable set search_path = '' as $$
  with d as (
    select measure.normalize_domain(p_domain) as domain
  ), sfx as (
    select s.domain, length(s.domain) as len from d, unnest(measure.domain_suffixes(d.domain)) as s(domain)
  ), owned as (
    select measure.normalize_domain(canonical_domain) as domain from app.sites where id = p_site_id
    union
    select measure.normalize_domain(hostname) from app.site_domains where site_id = p_site_id
  ), candidates as (
    select 'owned'::measure.source_role as role, null::uuid as entity_id, 1 as tier, 0 as len, null::timestamptz as created_at
    from d where exists (select 1 from owned o where d.domain = o.domain or right(d.domain, length(o.domain) + 1) = '.' || o.domain)
    union all
    select o.role, null, 2, sfx.len, null
    from app.sites s
    join measure.site_source_overrides o on o.site_id = s.id and o.org_id = s.org_id
    join sfx on sfx.domain = o.domain
    where s.id = p_site_id
    union all
    select 'competitor', e.id, 3, sfx.len, e.created_at
    from app.sites s
    join context.entities e on e.org_id = s.org_id and e.type = 'competitor'
    cross join lateral unnest(e.domains) as ed(domain)
    join sfx on sfx.domain = ed.domain
    where s.id = p_site_id
    union all
    select c.role, null, 4, sfx.len, null
    from measure.source_domains c join sfx on sfx.domain = c.domain
    union all
    select 'unknown', null, 5, 0, null
  )
  select c.role, c.entity_id from candidates c order by c.tier, c.len desc, c.created_at, c.entity_id limit 1
$$;

alter table measure.serp_citations add column if not exists source_role measure.source_role;
comment on column measure.serp_citations.source_role is
  'What the cited site is to this site (measure.classify_source). Competitor rows carry the competitor in entity_id. Restated when an override or a competitor''s domains change.';

-- Writers classify in code (one context per batch); a row that arrives
-- without a role is classified here, so none is ever left out.
create or replace function measure.citation_source_role()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.source_role is null then
    if new.is_owned then
      new.source_role := 'owned';
    else
      select r.role, coalesce(r.entity_id, new.entity_id) into new.source_role, new.entity_id
      from measure.classify_source(new.site_id, new.domain) r;
    end if;
  end if;
  return new;
end $$;

create trigger serp_citations_source_role before insert on measure.serp_citations
  for each row execute function measure.citation_source_role();

-- ── competitors from topics ─────────────────────────────────────────────────
create or replace function measure.seed_competitor_domains(p_org_id uuid, p_domains text[])
returns table (domain text)
language plpgsql set search_path = '' as $$
declare
  d text;
  catalogued measure.source_role;
  matches uuid[];
begin
  -- Shortest first, so a domain is placed before its subdomains and they fold into it.
  for d in
    select n.domain from unnest(p_domains) as u(raw), lateral (select measure.normalize_domain(u.raw) as domain) n
    where measure.is_domain(n.domain) group by n.domain order by length(n.domain), n.domain
  loop
    -- Already a competitor's, itself or under one of its domains (login.jumpcloud.com
    -- next to jumpcloud.com): a subdomain already counts as that competitor.
    continue when exists (
      select 1 from context.entities e cross join lateral unnest(e.domains) as x(domain)
      where e.org_id = p_org_id and e.type = 'competitor' and (d = x.domain or right(d, length(x.domain) + 1) = '.' || x.domain));
    -- An entity of that name someone said is not a competitor stays that way
    -- (the conflict below would otherwise promote it, as upsertEntity would).
    continue when exists (
      select 1 from context.entities e
      where e.org_id = p_org_id and lower(e.name) = d and e.type <> 'competitor' and e.metadata ? 'removed_as_competitor_at');
    -- The org's own, or under it.
    continue when exists (
      select 1 from (
        select measure.normalize_domain(s.canonical_domain) as o from app.sites s where s.org_id = p_org_id
        union select measure.normalize_domain(h.hostname) from app.site_domains h where h.org_id = p_org_id
      ) own where d = own.o or right(d, length(own.o) + 1) = '.' || own.o);
    -- A forum, review site, publisher… stays one; a vendor watched as a rival is one.
    select c.role into catalogued from measure.source_domains c
      where c.domain = any (measure.domain_suffixes(d)) order by length(c.domain) desc limit 1;
    continue when catalogued is not null and catalogued <> 'vendor_other';

    select array_agg(e.id) into matches from context.entities e
      where e.org_id = p_org_id and e.type = 'competitor'
        and regexp_replace(lower(e.name), '[^a-z0-9]', '', 'g') = regexp_replace(split_part(d, '.', 1), '[^a-z0-9]', '', 'g');
    if cardinality(matches) = 1 then
      update context.entities
        set domains = array(select distinct x from unnest(domains || array[d]) as x order by x), updated_at = now()
        where id = matches[1];
    else
      -- An entity already named after the domain becomes the competitor only
      -- when it is one or an ordinary entity; the brand, a product, an
      -- integration… keeps its type and gets no domain (saveCompetitor refuses
      -- the same), and the domain is not reported as added.
      insert into context.entities (org_id, type, name, domains, metadata)
      values (p_org_id, 'competitor', d, array[d], jsonb_build_object('seeded_from', 'topic_competitor_domains'))
      on conflict (org_id, lower(name)) do update
        set domains = array(select distinct x from unnest(context.entities.domains || excluded.domains) as x order by x),
            type = 'competitor',
            updated_at = now()
        where context.entities.type in ('competitor', 'other');
      continue when not found;
    end if;
    domain := d;
    return next;
  end loop;
end $$;

do $$
declare r record;
begin
  for r in
    select t.org_id, array_agg(distinct x) as domains
    from measure.topics t cross join unnest(t.competitor_domains) as x
    where t.org_id is not null
    group by t.org_id
  loop
    perform measure.seed_competitor_domains(r.org_id, r.domains);
  end loop;
end $$;

-- ── backfill ────────────────────────────────────────────────────────────────
update measure.serp_citations set source_role = 'owned' where is_owned and source_role is null;

-- Classified once per (site, domain), then written to every row with it
-- (materialized: inlined, the planner calls classify_source per joined row).
with d as (
  select distinct site_id, domain from measure.serp_citations where not is_owned and source_role is null
), cls as materialized (
  select d.site_id, d.domain, r.role, r.entity_id from d cross join lateral measure.classify_source(d.site_id, d.domain) r
)
update measure.serp_citations c set source_role = cls.role, entity_id = coalesce(cls.entity_id, c.entity_id)
from cls
where c.site_id = cls.site_id and c.domain = cls.domain and not c.is_owned and c.source_role is null;

alter table measure.serp_citations alter column source_role set not null;

-- The competitor read models filter by role per site.
create index if not exists serp_citations_site_role_idx on measure.serp_citations (site_id, source_role);
-- Deleting a competitor entity sets entity_id null; without an index that scans every citation.
create index if not exists serp_citations_entity_idx on measure.serp_citations (entity_id) where entity_id is not null;

-- Pages analysed before roles existed include forums, review sites and the
-- rest of lib/measure/source-roles.ts NON_TARGET_SOURCE_ROLES (a test checks
-- this list): they leave the structural target. From here the read model
-- filters by role and every analysis prunes the same way.
with d as (
  select distinct site_id, domain from measure.competitor_pages
), roles as materialized (
  select d.site_id, d.domain, r.role from d cross join lateral measure.classify_source(d.site_id, d.domain) r
)
delete from measure.competitor_pages p using roles
where p.site_id = roles.site_id and p.domain = roles.domain
  and roles.role in ('owned', 'ugc_forum', 'video', 'professional_social', 'review_platform', 'reference_wiki', 'directory', 'partner_marketplace');

-- ── RLS ────────────────────────────────────────────────────────────────────
-- The catalogue is public knowledge; every signed-in user may read it.
alter table measure.source_domains enable row level security;
alter table measure.source_domains force row level security;
create policy source_domains_read on measure.source_domains for select using (true);

alter table measure.site_source_overrides enable row level security;
alter table measure.site_source_overrides force row level security;
create policy tenant_read on measure.site_source_overrides for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());
create policy tenant_write on measure.site_source_overrides for all
  using (org_id = any (app.auth_org_ids())) with check (org_id = any (app.auth_org_ids()));

revoke all on measure.source_domains, measure.site_source_overrides from renderer;
