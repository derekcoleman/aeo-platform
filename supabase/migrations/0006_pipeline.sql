-- ============================================================================
-- 0006 — Content pipeline: opportunities → briefs → versions → QA → approvals
--         → publish.
--
-- opportunities     ranked queue. `score_breakdown` is stored next to `score`
--                   so a number is arguable, not magic. `dedupe_key` stops the
--                   scanner reopening the same citation gap every night.
-- briefs            structured spec (jsonb) + the 40–60 word target answer,
--                   written first because it is what gets cited.
-- authors           real named people. E-E-A-T and the site-reputation-abuse
--                   compliance argument both rest on this table.
-- content_versions  every generated/edited body, append-only, diffable.
--                   `structure_score` is the shared rule registry's verdict.
-- content_sources   the citation ledger: every `{{src:key}}` in a body resolves
--                   to a row here with URL + verbatim quote, so fact-checking
--                   is a string assertion rather than a judgment.
-- qa_results        one row per gate per version; failure routes back to a
--                   specific stage.
-- approvals         the human gate. A Slack Block Kit click, an app button or
--                   ops all land here and emit `approval/decided`, which is
--                   what resumes the pipeline's waitForEvent.
-- ops.llm_calls     durable per-tenant cost record. Inngest traces are not a
--                   billing system; "what does this customer cost us" is one
--                   query on this table.
-- ============================================================================

create type content.opportunity_source as enum ('citation_gap', 'question_graph', 'signal', 'gsc', 'manual', 'refresh');
create type content.opportunity_status as enum ('open', 'queued', 'in_progress', 'published', 'dismissed', 'failed');
create type content.brief_status       as enum ('drafted', 'pending_approval', 'approved', 'changes_requested', 'superseded');
create type content.approval_kind      as enum ('brief', 'draft');
create type content.approval_status    as enum ('pending', 'approve', 'changes', 'regenerate', 'expired');
create type content.approval_source    as enum ('slack', 'app', 'ops');
create type app.approval_policy        as enum ('auto_publish', 'approve_brief', 'approve_post', 'approve_both');

-- Per-site human gate policy. approve_both is the default because the
-- compliance story ("their approval, only they could write it") depends on it;
-- auto_publish is opt-in and never the default.
alter table app.sites add column approval_policy app.approval_policy not null default 'approve_both';

-- Denormalise org_id from the site / the content item so child policies never
-- join upward. Same shape as measure.site_org_id().
create or replace function content.site_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from app.sites where id = new.site_id;
  end if;
  return new;
end $$;

create or replace function content.item_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from content.content_items where id = new.content_item_id;
  end if;
  return new;
end $$;

create or replace function content.version_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from content.content_versions where id = new.content_version_id;
  end if;
  return new;
end $$;

-- ── authors ─────────────────────────────────────────────────────────────────
create table content.authors (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  site_id          uuid not null references app.sites (id) on delete cascade,
  name             text not null,
  job_title        text,
  bio              text,
  url              text,
  same_as          jsonb not null default '[]'::jsonb,   -- LinkedIn, X, personal site
  is_client_person boolean not null default true,
  is_default       boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint authors_same_as_is_array check (jsonb_typeof(same_as) = 'array')
);
create index authors_site_idx on content.authors (site_id);
create unique index authors_default_uq on content.authors (site_id) where is_default;
create trigger authors_org before insert on content.authors
  for each row execute function content.site_org_id();

-- ── opportunities ───────────────────────────────────────────────────────────
create table content.opportunities (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  site_id          uuid not null references app.sites (id) on delete cascade,
  source           content.opportunity_source not null,
  status           content.opportunity_status not null default 'open',
  title            text not null,
  target_query     text not null,
  question_id      uuid references measure.questions (id) on delete set null,
  -- A refresh opportunity points at the asset to improve rather than a new slug.
  content_item_id  uuid references content.content_items (id) on delete set null,
  score            numeric(6, 2) not null default 0,
  score_breakdown  jsonb not null default '{}'::jsonb,
  evidence         jsonb not null default '{}'::jsonb,
  dedupe_key       text not null,
  dismissed_reason text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (site_id, dedupe_key),
  constraint opportunities_breakdown_is_object check (jsonb_typeof(score_breakdown) = 'object')
);
create index opportunities_queue_idx on content.opportunities (site_id, status, score desc);
create trigger opportunities_org before insert on content.opportunities
  for each row execute function content.site_org_id();

-- ── briefs ──────────────────────────────────────────────────────────────────
create table content.briefs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  site_id          uuid not null references app.sites (id) on delete cascade,
  opportunity_id   uuid references content.opportunities (id) on delete set null,
  version          int not null default 1,
  status           content.brief_status not null default 'drafted',
  -- The whole structured brief (BriefSpec in lib/pipeline/types.ts):
  -- head question, target answer, outline of question-form H2s, FAQ, intent,
  -- entities, structural target, internal link targets, POV, banned claims.
  spec             jsonb not null,
  target_answer    text not null,
  model_run        jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint briefs_spec_is_object check (jsonb_typeof(spec) = 'object')
);
create index briefs_site_idx on content.briefs (site_id, created_at desc);
create index briefs_opportunity_idx on content.briefs (opportunity_id);
create trigger briefs_org before insert on content.briefs
  for each row execute function content.site_org_id();

-- ── content items gain their pipeline lineage ───────────────────────────────
alter table content.content_items
  add column title            text,
  add column brief_id         uuid references content.briefs (id) on delete set null,
  add column author_id        uuid references content.authors (id) on delete set null,
  add column opportunity_id   uuid references content.opportunities (id) on delete set null,
  add column current_version_id uuid;   -- FK added below, after content_versions exists

-- ── versions ────────────────────────────────────────────────────────────────
create table content.content_versions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  content_item_id  uuid not null references content.content_items (id) on delete cascade,
  version_no       int not null,
  title            text not null,
  description      text,
  -- Markdown is the source of truth; html is derived at render time and kept
  -- so QA gates and previews read exactly what will be published.
  body_md          text not null,
  body_html        text not null,
  frontmatter      jsonb not null default '{}'::jsonb,
  schema_jsonld    jsonb,
  structure_score  jsonb,
  word_count       int not null default 0,
  model_run        jsonb,
  created_at       timestamptz not null default now(),
  unique (content_item_id, version_no)
);
create index content_versions_item_idx on content.content_versions (content_item_id, version_no desc);
create trigger content_versions_org before insert on content.content_versions
  for each row execute function content.item_org_id();

alter table content.content_items
  add constraint content_items_current_version_fk
  foreign key (current_version_id) references content.content_versions (id) on delete set null;

-- ── citation ledger ─────────────────────────────────────────────────────────
create table content.content_sources (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references app.organizations (id) on delete cascade,
  content_version_id uuid not null references content.content_versions (id) on delete cascade,
  key                text not null,                  -- the `{{src:key}}` marker
  url                text not null,
  publisher          text,
  title              text,
  -- Verbatim. Verification asserts this string appears at `url`.
  quote              text not null,
  accessed_at        timestamptz not null default now(),
  verified           boolean not null default false,
  verified_at        timestamptz,
  verification       jsonb,
  unique (content_version_id, key)
);
create trigger content_sources_org before insert on content.content_sources
  for each row execute function content.version_org_id();

-- ── QA gates ────────────────────────────────────────────────────────────────
create table content.qa_results (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references app.organizations (id) on delete cascade,
  content_version_id uuid not null references content.content_versions (id) on delete cascade,
  gate               text not null,                  -- structure | sources | mechanics | slop | …
  passed             boolean not null,
  detail             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index qa_results_version_idx on content.qa_results (content_version_id, created_at desc);
create trigger qa_results_org before insert on content.qa_results
  for each row execute function content.version_org_id();

-- ── approvals ───────────────────────────────────────────────────────────────
create table content.approvals (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references app.organizations (id) on delete cascade,
  site_id            uuid not null references app.sites (id) on delete cascade,
  kind               content.approval_kind not null,
  brief_id           uuid references content.briefs (id) on delete cascade,
  content_version_id uuid references content.content_versions (id) on delete cascade,
  status             content.approval_status not null default 'pending',
  requested_at       timestamptz not null default now(),
  expires_at         timestamptz,
  decided_at         timestamptz,
  decided_by         jsonb,                          -- { userId, name }
  source             content.approval_source,
  note               text,
  -- Where the Block Kit message lives, so a decision can rewrite it.
  slack_channel      text,
  slack_ts           text,
  constraint approvals_target check (
    (kind = 'brief' and brief_id is not null and content_version_id is null) or
    (kind = 'draft' and content_version_id is not null)
  )
);
create index approvals_pending_idx on content.approvals (site_id, requested_at desc) where status = 'pending';
create trigger approvals_org before insert on content.approvals
  for each row execute function content.site_org_id();

-- ── LLM cost ledger ─────────────────────────────────────────────────────────
create table ops.llm_calls (
  id              bigint generated always as identity primary key,
  org_id          uuid references app.organizations (id) on delete cascade,
  site_id         uuid references app.sites (id) on delete set null,
  task_key        text not null,                     -- pipeline.brief | pipeline.draft.section | …
  model           text not null,
  prompt_version  text,
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  cost_usd        numeric(10, 5) not null default 0,
  content_item_id uuid references content.content_items (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index llm_calls_org_idx on ops.llm_calls (org_id, created_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'content.authors', 'content.opportunities', 'content.briefs', 'content.content_versions',
    'content.content_sources', 'content.qa_results', 'content.approvals', 'ops.llm_calls'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
  foreach t in array array[
    'content.authors', 'content.opportunities', 'content.briefs', 'content.content_versions',
    'content.content_sources', 'content.qa_results', 'content.approvals'
  ] loop
    execute format(
      'create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
  -- Members act on the queue (dismiss), manage authors, and decide approvals.
  -- Versions, sources and QA rows are written by the pipeline only.
  foreach t in array array['content.authors', 'content.opportunities', 'content.approvals'] loop
    execute format(
      'create policy tenant_write on %s for all using (org_id = any (app.auth_org_ids())) with check (org_id = any (app.auth_org_ids()))', t);
  end loop;
end $$;

create policy staff_read on ops.llm_calls for select using (app.auth_is_staff());

-- Default privileges already deny the renderer on new content tables; be explicit.
revoke all on all tables in schema content from renderer;
grant select on content.published_pages, content.site_render_config to renderer;
revoke all on all tables in schema ops from renderer;
