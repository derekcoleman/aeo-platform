-- ============================================================================
-- 0019 — Measurement integrity: idempotent demand mining, per-question
-- measurement errors, and restatements when the methodology moves a number.
--
-- measure.questions          + last_mine_batch: the mining batch (run:index)
--                            that last counted a sighting of the question. A
--                            retried batch finds its own key and adds nothing,
--                            so seen_count (and the demand score built on it)
--                            no longer doubles when a step re-runs.
--                            + last_measure_error / last_measure_error_at: why
--                            the last SERP snapshot of the question failed;
--                            serp-track records it and moves on to the next
--                            question instead of failing the batch.
-- measure.question_clusters  + updated_by_run: the mining batch that last
--                            wrote the cluster. A retried batch finds the
--                            cluster it already inserted; clusters from later
--                            runs merge into a stored one with a near centroid.
-- app.metric_restatements    one row per site, metric and methodology
--                            version: the value the previous method computes
--                            and the value the current one does, with the
--                            reason. Strategy, Demand and Attribution show the
--                            rows that changed a number; staff recompute them
--                            from /ops (metrics/restatement.requested).
-- ============================================================================

-- ── demand mining ───────────────────────────────────────────────────────────
alter table measure.questions
  add column if not exists last_mine_batch       text,
  add column if not exists last_measure_error    text,
  add column if not exists last_measure_error_at timestamptz;
comment on column measure.questions.last_mine_batch is 'Mining batch (Inngest run id : batch index) that last added to seen_count; the same batch never adds twice.';
comment on column measure.questions.last_measure_error is 'Why the last SERP snapshot of this question failed; cleared by the next one that succeeds.';

alter table measure.question_clusters
  add column if not exists updated_by_run text;
comment on column measure.question_clusters.updated_by_run is 'Mining batch that last inserted or merged into this cluster.';

create index if not exists question_clusters_run_idx
  on measure.question_clusters (site_id, updated_by_run) where updated_by_run is not null;

-- ── restatements ────────────────────────────────────────────────────────────
create table app.metric_restatements (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid references app.organizations (id) on delete cascade,
  site_id              uuid not null references app.sites (id) on delete cascade,
  metric               text not null,
  old_value            numeric,
  new_value            numeric,
  methodology_version  text not null,
  reason               text not null,
  computed_at          timestamptz not null default now(),
  unique (site_id, metric, methodology_version)
);
comment on table app.metric_restatements is
  'Old (previous methodology) and new value of a headline metric per site, so a page can explain a number that moved. Written by lib/app/restatement.ts.';
create index metric_restatements_site_idx on app.metric_restatements (site_id, methodology_version, computed_at desc);
create trigger metric_restatements_org before insert on app.metric_restatements
  for each row execute function app.site_org_id();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table app.metric_restatements enable row level security;
alter table app.metric_restatements force row level security;
create policy tenant_read on app.metric_restatements for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

revoke all on app.metric_restatements from renderer;
