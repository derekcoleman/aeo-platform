-- ============================================================================
-- 0025 — Opportunity scoring: what kind of work an opportunity is, why one
-- was dismissed, and the keyword data the scorer reads.
--
-- The queue used to score every opportunity on fixed weights and treat each
-- as a new article. One scorer now ranks them all on expected value
-- (lib/pipeline/opportunities.ts scoreEV0: demand × intent × gap prior ×
-- business value × topical fit ÷ effort), and the effort depends on the
-- action, so the action is a column. Rows already in the queue keep their
-- old-formula scores here: SQL has none of EV0's inputs (topic weights,
-- Search Console demand, topical fit). The next opportunity scan re-scores
-- every open, queued or running one whose breakdown is not EV0's
-- (rescoreLegacyOpportunities), and until then any producer that touches
-- one replaces its score rather than comparing across the two scales.
--
-- content.action_type          new_page | refresh | expand | consolidate |
--                              update_stats (figures and dates only, for a
--                              page that is winning) | setup_task (work the
--                              pipeline cannot do: the page that covers the
--                              question is not one we can edit).
-- content.opportunities        + action_type, default new_page; every
--                              refresh opportunity already stored is one.
--                              + dismiss_reason: why it was dismissed. A
--                              person picks not_relevant, duplicate,
--                              covered_elsewhere, off_brand, low_value or
--                              other; the pipeline records auto_coverage
--                              (the site already covers the question),
--                              auto_velocity, auto_topical_floor (nothing
--                              ties the question to the site's topics,
--                              seeds or brand) and model_refusal. The free
--                              text in dismissed_reason stays the detail. A
--                              trigger clears the reason when the row is
--                              opened, queued or started again.
-- content.content_items        + pipeline_published_at: when the pipeline
--                              last published new work on the item (a new
--                              page, a refresh, a figures update), which the
--                              publishing pace counts. published_at also
--                              moves on a rollback, which puts back what was
--                              there; this does not.
-- measure.questions            + search_volume (monthly), keyword_difficulty
--                              (0–100) and search_intent (informational |
--                              navigational | commercial | transactional),
--                              from a keyword data provider; the
--                              competitor organic gap fills them. Without
--                              them the scorer falls back to Search Console
--                              impressions, then the mined demand score.
-- ============================================================================

-- ── action types ────────────────────────────────────────────────────────────
create type content.action_type as enum ('new_page', 'refresh', 'expand', 'consolidate', 'update_stats', 'setup_task');

alter table content.opportunities
  add column if not exists action_type content.action_type not null default 'new_page';
comment on column content.opportunities.action_type is 'The work this opportunity is: a new page, a refresh, an expansion, a consolidation, a statistics update or a setup task. Sets the effort the scorer divides by.';

update content.opportunities set action_type = 'refresh'
where source = 'refresh' and action_type = 'new_page';

-- ── dismissal reasons ───────────────────────────────────────────────────────
create type content.dismiss_reason as enum (
  'not_relevant', 'duplicate', 'covered_elsewhere', 'off_brand', 'low_value', 'other',
  'auto_coverage', 'auto_velocity', 'auto_topical_floor', 'model_refusal'
);

alter table content.opportunities
  add column if not exists dismiss_reason content.dismiss_reason;
comment on column content.opportunities.dismiss_reason is 'Why it was dismissed (or, for model_refusal, failed): a person''s choice or the pipeline''s guard. dismissed_reason holds the detail.';

-- A reason belongs to the dismissal it explains: an opportunity opened,
-- queued or started again (a person asks for it after all) loses it.
create or replace function content.clear_dismiss_reason()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status in ('open', 'queued', 'in_progress') then
    new.dismiss_reason := null;
  end if;
  return new;
end $$;

create trigger opportunities_dismiss_reason before insert or update of status, dismiss_reason on content.opportunities
  for each row execute function content.clear_dismiss_reason();

-- ── keyword data ────────────────────────────────────────────────────────────
alter table measure.questions
  add column if not exists search_volume       int,
  add column if not exists keyword_difficulty  smallint,
  add column if not exists search_intent       text;
alter table measure.questions add constraint questions_search_volume_check check (search_volume is null or search_volume >= 0);
alter table measure.questions add constraint questions_keyword_difficulty_check check (keyword_difficulty is null or keyword_difficulty between 0 and 100);
alter table measure.questions add constraint questions_search_intent_check
  check (search_intent is null or search_intent in ('informational', 'navigational', 'commercial', 'transactional'));
comment on column measure.questions.search_volume is 'Average monthly searches for the query, from a keyword data provider; null when none measured it.';
comment on column measure.questions.keyword_difficulty is 'Keyword difficulty 0–100 from a keyword data provider.';
comment on column measure.questions.search_intent is 'The provider''s main search intent for the query.';

-- ── publishing pace ─────────────────────────────────────────────────────────
alter table content.content_items
  add column if not exists pipeline_published_at timestamptz;
comment on column content.content_items.pipeline_published_at is 'When the pipeline last published new work on this item (a new page, a refresh, a figures update): what the publishing pace counts. A rollback moves published_at, not this.';
-- Before this column a rollback could not be told from a publish: earlier publishes are taken as they stand.
update content.content_items set pipeline_published_at = published_at
where pipeline_published_at is null and published_at is not null;
create index if not exists content_items_pipeline_published_idx on content.content_items (site_id, pipeline_published_at)
  where pipeline_published_at is not null;
