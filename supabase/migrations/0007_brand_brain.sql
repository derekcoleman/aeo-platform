-- ============================================================================
-- 0007 — Brand brain v1: chunks, entities, facts, manifests, signals.
--
-- context_chunks    Layer 1 (recall). Structure-aware chunks of redacted
--                   documents with a pinned embedding + FTS vector. Hybrid
--                   retrieval (vector ∪ FTS → RRF) reads this table only.
-- entities          Layer 3. Products, features, competitors, customers, with
--                   aliases[] and wikidata_id. Resolved by alias, never by
--                   substring — "Notion" inside "notionally" is the bug that
--                   silently corrupts a whole metric.
-- brand_facts       Layer 2 (precision, the anti-slop mechanism). Atomic,
--                   typed, dated, sourced claims extracted by a cheap model.
--                   Only status='verified' facts reach generation; a draft
--                   cites them as {{fact:key}} and QA checks each one exists,
--                   is verified and is currently effective.
-- brand_manifests   the versioned manifesto above all three layers. Every
--                   brief and version pins manifest_version_id so output is
--                   reproducible.
-- signals           deterministic newsworthiness detectors (term spikes,
--                   unanswered questions, competitor spikes), deduped by
--                   embedding, bridged into content.opportunities.
-- content_facts     which verified facts a version cited — the fact half of
--                   the citation ledger next to content_sources.
-- ============================================================================

create type context.fact_type as enum (
  'positioning', 'product_capability', 'pricing', 'integration', 'customer_proof', 'metric',
  'objection', 'icp_pain', 'differentiator', 'launch', 'terminology', 'banned_claim', 'competitor_claim'
);
create type context.fact_status     as enum ('candidate', 'verified', 'rejected', 'superseded');
create type context.fact_visibility as enum ('public', 'internal');
create type context.entity_type     as enum ('brand', 'product', 'feature', 'competitor', 'integration', 'customer', 'person', 'category', 'other');
create type context.manifest_status as enum ('draft', 'active', 'archived');
create type context.signal_kind     as enum ('term_spike', 'unanswered_question', 'competitor_spike');
create type context.signal_status   as enum ('new', 'bridged', 'dismissed');

-- ── documents gain ingest bookkeeping ───────────────────────────────────────
-- Redaction rewrites `text` in place and sets redacted = true, but leaves
-- content_sha256 as the hash of the provider's text: upsertDocuments compares
-- against that hash, so re-hashing the redacted text would make every sync
-- re-ingest (and un-redact) the row. chunked_sha256 / facts_sha256 record
-- which provider text the chunks / facts were derived from; a mismatch means
-- "re-derive".
alter table context.context_documents
  add column chunked_sha256     text,
  add column chunked_at         timestamptz,
  add column facts_sha256       text,
  add column facts_extracted_at timestamptz;
comment on column context.context_documents.content_sha256 is
  'sha256 of the provider text as synced (pre-redaction). Sync dedupe key; never re-hash after redaction.';
create index context_documents_unchunked_idx on context.context_documents (org_id)
  where chunked_sha256 is distinct from content_sha256;
create index context_documents_unextracted_idx on context.context_documents (org_id)
  where facts_sha256 is distinct from content_sha256;

-- Denormalise org_id from the document so chunk policies never join upward.
create or replace function context.document_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.org_id is null then
    select org_id into new.org_id from context.context_documents where id = new.document_id;
  end if;
  return new;
end $$;

-- ── chunks ──────────────────────────────────────────────────────────────────
create table context.context_chunks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references app.organizations (id) on delete cascade,
  document_id      uuid not null references context.context_documents (id) on delete cascade,
  ordinal          int not null,
  text             text not null,
  token_estimate   int not null default 0,
  embedding        vector(1536),
  embedding_model  text,
  -- Generated + stored with an explicit config so the FTS half of retrieval
  -- is deterministic and index-only; a session default_text_search_config
  -- must never change what a query matches.
  tsv              tsvector generated always as (to_tsvector('english', text)) stored,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (document_id, ordinal),
  constraint chunks_embedding_model_pairs check ((embedding is null) = (embedding_model is null)),
  constraint chunks_metadata_is_object check (jsonb_typeof(metadata) = 'object')
);
create index context_chunks_org_doc_idx on context.context_chunks (org_id, document_id);
create index context_chunks_tsv_idx on context.context_chunks using gin (tsv);
create index context_chunks_embedding_idx on context.context_chunks using hnsw (embedding vector_cosine_ops);
create trigger context_chunks_org before insert on context.context_chunks
  for each row execute function context.document_org_id();

-- ── entities ────────────────────────────────────────────────────────────────
create table context.entities (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references app.organizations (id) on delete cascade,
  type         context.entity_type not null default 'other',
  name         text not null,
  aliases      text[] not null default '{}',
  wikidata_id  text,
  description  text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint entities_name_nonempty check (length(btrim(name)) > 0),
  constraint entities_wikidata_shape check (wikidata_id is null or wikidata_id ~ '^Q[0-9]+$')
);
create unique index entities_org_name_uq on context.entities (org_id, lower(name));
create index entities_org_type_idx on context.entities (org_id, type);

-- serp_citations.entity_id predates this table; wire the FK now.
alter table measure.serp_citations
  add constraint serp_citations_entity_fk
  foreign key (entity_id) references context.entities (id) on delete set null;

-- ── facts ───────────────────────────────────────────────────────────────────
create table context.brand_facts (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references app.organizations (id) on delete cascade,
  site_id              uuid references app.sites (id) on delete set null,
  type                 context.fact_type not null,
  subject_entity_id    uuid references context.entities (id) on delete set null,
  subject_text         text not null,
  predicate            text not null,
  object_text          text not null,
  value_numeric        numeric,
  unit                 text,
  confidence           numeric(4, 3) not null default 0.5,
  effective_from       date,
  effective_to         date,
  status               context.fact_status not null default 'candidate',
  visibility           context.fact_visibility not null default 'internal',
  source_document_ids  uuid[] not null default '{}',
  source_quote         text,
  extracted_by_model   text,
  prompt_version       text,
  verified_by_user_id  uuid references app.users (id) on delete set null,
  verified_at          timestamptz,
  rejected_reason      text,
  supersedes_id        uuid references context.brand_facts (id) on delete set null,
  -- type + normalised subject + normalised predicate; one live candidate and
  -- one verified fact per key, so re-extraction merges instead of piling up.
  dedupe_key           text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint facts_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint facts_effective_range check (effective_to is null or effective_from is null or effective_to >= effective_from),
  constraint facts_verified_stamp check (status <> 'verified' or verified_at is not null)
);
create unique index brand_facts_candidate_uq on context.brand_facts (org_id, dedupe_key) where status = 'candidate';
create unique index brand_facts_verified_uq  on context.brand_facts (org_id, dedupe_key) where status = 'verified';
create index brand_facts_org_status_idx on context.brand_facts (org_id, status, type);
create index brand_facts_subject_idx on context.brand_facts (subject_entity_id) where subject_entity_id is not null;
create index brand_facts_sources_idx on context.brand_facts using gin (source_document_ids);

-- ── manifests ───────────────────────────────────────────────────────────────
create table context.brand_manifests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references app.organizations (id) on delete cascade,
  -- null = org-wide; a site-specific manifest wins over the org one.
  site_id       uuid references app.sites (id) on delete cascade,
  version       int not null,
  status        context.manifest_status not null default 'draft',
  -- ManifestDoc (lib/context/manifest.ts): category POV, contrarian takes,
  -- ICP, voice do/don't pairs, banned phrases, competitor stance, proof
  -- points, legal no-gos, terminology.
  doc           jsonb not null,
  -- How this version came to be: { kind: 'facts' | 'interview' | 'manual', ... }
  source        jsonb not null default '{}'::jsonb,
  model_run     jsonb,
  created_by    uuid references app.users (id) on delete set null,
  activated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, version),
  constraint manifests_doc_is_object check (jsonb_typeof(doc) = 'object')
);
-- One active manifest per (org, site-or-org-wide).
create unique index brand_manifests_active_uq
  on context.brand_manifests (org_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'active';
create index brand_manifests_org_idx on context.brand_manifests (org_id, version desc);

-- ── signals ─────────────────────────────────────────────────────────────────
create table context.signals (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references app.organizations (id) on delete cascade,
  site_id           uuid references app.sites (id) on delete cascade,
  kind              context.signal_kind not null,
  status            context.signal_status not null default 'new',
  title             text not null,
  evidence          jsonb not null default '{}'::jsonb,
  score             numeric(6, 2) not null default 0,
  dedupe_embedding  vector(1536),
  embedding_model   text,
  seen_count        int not null default 1,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  constraint signals_evidence_is_object check (jsonb_typeof(evidence) = 'object'),
  constraint signals_embedding_model_pairs check ((dedupe_embedding is null) = (embedding_model is null))
);
create index signals_org_recent_idx on context.signals (org_id, created_at desc);
create index signals_site_status_idx on context.signals (site_id, status) where site_id is not null;
create index signals_embedding_idx on context.signals using hnsw (dedupe_embedding vector_cosine_ops);

-- ── lineage into the pipeline ───────────────────────────────────────────────
alter table content.opportunities
  add column signal_id uuid references context.signals (id) on delete set null;
alter table content.briefs
  add column manifest_version_id uuid references context.brand_manifests (id) on delete set null;
alter table content.content_versions
  add column manifest_version_id uuid references context.brand_manifests (id) on delete set null;

-- The fact half of the citation ledger: every {{fact:key}} a version cited.
create table content.content_facts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid references app.organizations (id) on delete cascade,
  content_version_id  uuid not null references content.content_versions (id) on delete cascade,
  key                 text not null,
  fact_id             uuid references context.brand_facts (id) on delete set null,
  text                text not null,
  created_at          timestamptz not null default now(),
  unique (content_version_id, key)
);
create index content_facts_fact_idx on content.content_facts (fact_id) where fact_id is not null;
create trigger content_facts_org before insert on content.content_facts
  for each row execute function content.version_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'context.context_chunks', 'context.entities', 'context.brand_facts',
    'context.brand_manifests', 'context.signals', 'content.content_facts'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format(
      'create policy tenant_read on %s for select using (org_id = any (app.auth_org_ids()) or app.auth_is_staff())', t);
  end loop;
  -- Members curate the brain: verify/reject facts, edit entities, activate a
  -- manifest. Chunks, signals and content_facts are written by jobs only.
  foreach t in array array['context.entities', 'context.brand_facts', 'context.brand_manifests'] loop
    execute format(
      'create policy tenant_write on %s for all using (org_id = any (app.auth_org_ids())) with check (org_id = any (app.auth_org_ids()))', t);
  end loop;
end $$;

revoke all on all tables in schema context from renderer;
revoke all on all tables in schema content from renderer;
grant select on content.published_pages, content.site_render_config to renderer;
