-- ============================================================================
-- 0024 — Answer ledger: every AI answer we observe, from whichever engine and
-- by whichever method, in one table, never blended.
--
-- Google AI Overviews from our own SERP trackers, Profound's synced answers
-- (ChatGPT, Perplexity, Gemini, Copilot, AI Mode…) and our own answer probes
-- through OpenRouter all land in measure.serp_snapshots. What tells them
-- apart is now a column, not a convention each read model has to remember.
--
-- measure.collection_method   serp (a SERP vendor's Google results) |
--                             ui_scrape (a consumer app, scraped) |
--                             api_probe (a model with web search, asked
--                             through its API: not the consumer app) |
--                             first_party (the customer's own export) |
--                             third_party (another vendor's data: Profound).
-- measure.serp_snapshots      + engine (google, chatgpt, perplexity, gemini,
--                             claude, google_aio, ai_mode…), model_version
--                             (the model that answered, with how it
--                             searched), collection_method, sample_index and
--                             paraphrase_id (which repeat of which wording of
--                             the prompt), run_id (the job run), answer_text
--                             and answer_hash, citations_observable (whether
--                             the engine exposed its sources at all: an
--                             engine's own search may return none, and an
--                             answer with none cannot say whether it cited
--                             us). A trigger labels every Profound row
--                             third_party, by its engine, with no AI Overview
--                             flag unless the engine is Google's AI Overview,
--                             and every OpenRouter row api_probe; a check
--                             keeps any other writer from mislabelling one.
-- measure.serp_citations      + position_in_answer: the order in which the
--                             answer first refers to the source.
-- measure.answer_mentions     the brand, its products and the named
--                             competitors each answer mentions: how often,
--                             where first, at which rank of a list, and
--                             whether it recommends them. Site and org come
--                             from the snapshot; the entity must be the
--                             snapshot's org's. Tenant-read on the
--                             denormalised org_id, revoked from the renderer.
--
-- Two views, both security_invoker (a member reading them gets the tables'
-- own row security), are what the read models read instead of filtering
-- providers themselves:
--   measure.v_native_aio           our own SERP trackers' Google results:
--                                  collection_method serp from dataforseo
--                                  or serpapi (lib/demand/store.ts
--                                  NATIVE_PROVIDERS; a test checks the two
--                                  agree). Never Profound, never a probe.
--   measure.v_answer_observations  everything else (probes, Profound), with
--                                  the question's topic.
-- Cached rows stay in both: the SERP and answer caches are shared across
-- tenants, so a cached row is often the only measurement a site has of that
-- question that day.
--
-- measure.backfill_answer_ledger(site?) labels the Profound rows already
-- stored (engine from what Profound reported, third_party, the AI Overview
-- flag cleared for other engines, citations on the engine's surface:
-- ai_overview for Google AI Overviews, ai_mode for AI Mode, llm_answer
-- otherwise), every site's or one site's. It runs here for every site and is
-- safe to run again. A Gemini answer stored as an AI Overview
-- before Profound's engine names were read correctly keeps that engine until
-- the connector's next 90-day re-sync rewrites it.
-- ============================================================================

-- ── engines and surfaces ────────────────────────────────────────────────────
create type measure.collection_method as enum ('serp', 'ui_scrape', 'api_probe', 'first_party', 'third_party');

-- `Google AI Overview` → `google_ai_overview`; empty → `unknown`. The same
-- rule as answerEngineSlug() in lib/answers/engines.ts.
create or replace function measure.engine_slug(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'), '_'), ''), 'unknown')
$$;

-- The surface an engine's citations are on. The same rule as answerSurface()
-- in lib/answers/engines.ts.
create or replace function measure.answer_surface(p_engine text)
returns measure.citation_surface language sql immutable set search_path = '' as $$
  select (case p_engine when 'google_aio' then 'ai_overview' when 'ai_mode' then 'ai_mode' else 'llm_answer' end)::measure.citation_surface
$$;

-- ── snapshots ───────────────────────────────────────────────────────────────
alter table measure.serp_snapshots
  add column if not exists engine               text not null default 'google',
  add column if not exists model_version        text,
  add column if not exists collection_method    measure.collection_method not null default 'serp',
  add column if not exists sample_index         smallint not null default 0,
  add column if not exists paraphrase_id        uuid,
  add column if not exists run_id               text,
  add column if not exists answer_text          text,
  add column if not exists answer_hash          text,
  add column if not exists citations_observable boolean;
alter table measure.serp_snapshots add constraint serp_snapshots_engine_shape check (engine ~ '^[a-z0-9_]+$');
alter table measure.serp_snapshots add constraint serp_snapshots_sample_index check (sample_index >= 0);
comment on column measure.serp_snapshots.engine is 'Which answer engine: google for our SERP trackers; chatgpt, perplexity, gemini, claude for probes; Profound''s engine names for its rows.';
comment on column measure.serp_snapshots.model_version is 'The model that answered and how it searched (model+web:engine), for probes.';
comment on column measure.serp_snapshots.collection_method is 'How the answer was observed. Read models never mix methods: v_native_aio is serp only.';
comment on column measure.serp_snapshots.sample_index is 'Which repeat of the same prompt to the same engine on the same run (0-based).';
comment on column measure.serp_snapshots.paraphrase_id is 'Which wording of the prompt, when a panel paraphrases it; null for the prompt as written.';
comment on column measure.serp_snapshots.run_id is 'The job run that took the observation.';
comment on column measure.serp_snapshots.answer_text is 'The answer as the engine returned it (probes).';
comment on column measure.serp_snapshots.answer_hash is 'sha256 of answer_text, to tell identical answers apart from changed ones.';
comment on column measure.serp_snapshots.citations_observable is 'The engine exposed at least one source. False: none came back, which cannot tell "cited nothing" from "hid its sources", so citation share leaves the answer out.';

alter table measure.serp_citations add column if not exists position_in_answer smallint;
comment on column measure.serp_citations.position_in_answer is 'Order (1-based) in which the answer first refers to this source; null when it never does in the text.';

-- Every writer gets the label right, whatever it sent: a Profound row is
-- third-party data on the engine Profound reported (its AI Overview flag only
-- means something for Google AI Overviews), a probe is a probe.
create or replace function measure.snapshot_collection()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.provider = 'profound' then
    new.collection_method := 'third_party';
    if new.engine = 'google' then
      new.engine := measure.engine_slug(new.raw->>'engine');
    end if;
    if new.engine <> 'google_aio' then
      new.aio_triggered := null;
    end if;
  elsif new.provider = 'openrouter' then
    new.collection_method := 'api_probe';
    new.aio_triggered := null;
  end if;
  return new;
end $$;

create trigger serp_snapshots_collection before insert on measure.serp_snapshots
  for each row execute function measure.snapshot_collection();

-- ── backfill ────────────────────────────────────────────────────────────────
create or replace function measure.backfill_answer_ledger(p_site_id uuid default null)
returns table (snapshots bigint, citations bigint)
language plpgsql set search_path = '' as $$
declare
  n_snapshots bigint;
  n_citations bigint;
begin
  update measure.serp_snapshots s
  set engine = measure.engine_slug(s.raw->>'engine'),
      collection_method = 'third_party',
      aio_triggered = case when measure.engine_slug(s.raw->>'engine') = 'google_aio' then s.aio_triggered end
  where s.provider = 'profound' and (p_site_id is null or s.site_id = p_site_id)
    and (s.engine is distinct from measure.engine_slug(s.raw->>'engine')
         or s.collection_method <> 'third_party'
         or (s.aio_triggered is not null and measure.engine_slug(s.raw->>'engine') <> 'google_aio'));
  get diagnostics n_snapshots = row_count;

  update measure.serp_citations c
  set surface = measure.answer_surface(s.engine)
  from measure.serp_snapshots s
  where s.id = c.serp_snapshot_id and s.provider = 'profound' and (p_site_id is null or c.site_id = p_site_id)
    and c.surface is distinct from measure.answer_surface(s.engine);
  get diagnostics n_citations = row_count;

  return query select n_snapshots, n_citations;
end $$;
comment on function measure.backfill_answer_ledger(uuid) is
  'Label stored Profound rows (every site''s, or one site''s) by engine and method, and move their citations to the engine''s surface. Idempotent; returns the rows it changed.';

select * from measure.backfill_answer_ledger();

-- Only our SERP vendors' rows are SERP rows, and theirs are SERP rows (or a
-- vendor's scrape of an app); Profound's are third-party data, OpenRouter's probes.
alter table measure.serp_snapshots add constraint serp_snapshots_collection_check check (
  (provider <> 'profound' or collection_method = 'third_party')
  and (provider <> 'openrouter' or collection_method = 'api_probe')
  and (collection_method <> 'serp' or provider in ('dataforseo', 'serpapi'))
  and (provider not in ('dataforseo', 'serpapi') or collection_method in ('serp', 'ui_scrape'))
);

-- A probe step that runs again (a retry after its write committed) finds its
-- own row instead of adding a second observation of the same sample.
create unique index serp_snapshots_probe_sample_idx
  on measure.serp_snapshots (question_id, engine, sample_index, paraphrase_id, run_id) nulls not distinct
  where collection_method = 'api_probe' and run_id is not null;
-- The answer read models: one site's observations by engine over a window.
create index serp_snapshots_answers_idx
  on measure.serp_snapshots (site_id, engine, fetched_at desc) where collection_method <> 'serp';

-- ── mentions ────────────────────────────────────────────────────────────────
create table measure.answer_mentions (
  id                 uuid primary key default gen_random_uuid(),
  snapshot_id        uuid not null references measure.serp_snapshots (id) on delete cascade,
  org_id             uuid references app.organizations (id) on delete cascade,
  site_id            uuid not null references app.sites (id) on delete cascade,
  entity_id          uuid not null references context.entities (id) on delete cascade,
  -- the brand or one of its products
  is_brand           boolean not null default false,
  matched_alias      text not null,
  mention_count      int not null default 1,
  -- character offset of the first mention in answer_text
  first_offset       int,
  -- position in the first list (numbered, bulleted or headed) that names it
  list_rank          smallint,
  is_listed          boolean not null default false,
  is_recommended     boolean not null default false,
  -- filled by a later judge, not the extractor
  sentiment          text,
  claims             jsonb not null default '[]'::jsonb,
  accuracy_flag      text,
  judge_version      text,
  extractor_version  text not null,
  created_at         timestamptz not null default now(),
  unique (snapshot_id, entity_id),
  constraint answer_mentions_count check (mention_count > 0),
  constraint answer_mentions_rank check (list_rank is null or list_rank > 0),
  constraint answer_mentions_sentiment check (sentiment is null or sentiment in ('positive', 'neutral', 'negative')),
  constraint answer_mentions_accuracy check (accuracy_flag is null or accuracy_flag in ('accurate', 'inaccurate', 'unverifiable'))
);
comment on table measure.answer_mentions is
  'Which of the org''s brand, products and named competitors an observed answer mentions, ranks and recommends. Written by lib/answers/record.ts.';
create index answer_mentions_site_entity_idx on measure.answer_mentions (site_id, entity_id);
-- Deleting an entity cascades here; without an index that scans every mention.
create index answer_mentions_entity_idx on measure.answer_mentions (entity_id);

-- Site and org are the snapshot's, whatever the writer passed, and the
-- entity must belong to that org: a mention never points across tenants.
create or replace function measure.answer_mention_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  select s.site_id, s.org_id into new.site_id, new.org_id from measure.serp_snapshots s where s.id = new.snapshot_id;
  if not exists (select 1 from context.entities e where e.id = new.entity_id and e.org_id = new.org_id) then
    raise exception 'entity % does not belong to the organisation of snapshot %', new.entity_id, new.snapshot_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger answer_mentions_scope
  before insert or update of snapshot_id, site_id, org_id, entity_id on measure.answer_mentions
  for each row execute function measure.answer_mention_scope();

-- ── views ───────────────────────────────────────────────────────────────────
create view measure.v_native_aio with (security_invoker = true) as
  select s.*
  from measure.serp_snapshots s
  where s.collection_method = 'serp' and s.provider in ('dataforseo', 'serpapi');
comment on view measure.v_native_aio is
  'Google results from our own SERP trackers only: the native AI Overview, featured snippet and organic numbers. Never Profound, never an answer probe.';

create view measure.v_answer_observations with (security_invoker = true) as
  select s.*, q.topic_id
  from measure.serp_snapshots s
  join measure.questions q on q.id = s.question_id
  where s.collection_method <> 'serp';
comment on view measure.v_answer_observations is
  'Every answer observed some other way than a SERP vendor: API probes and third-party data, each labelled by collection_method and engine. Read per method; never added to v_native_aio.';

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table measure.answer_mentions enable row level security;
alter table measure.answer_mentions force row level security;
create policy tenant_read on measure.answer_mentions for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

revoke all on measure.answer_mentions, measure.v_native_aio, measure.v_answer_observations from renderer;
