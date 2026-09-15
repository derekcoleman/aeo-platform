-- ============================================================================
-- 0014 — Sync requests: when a sync was asked for, so the UI can tell
-- "queued and waiting" from "queued and lost".
--
-- context.context_connections.sync_requested_at    set by the Sync now /
--                                                  connect actions once the
--                                                  event is accepted by the
--                                                  job runner.
-- context.context_connections.sync_requested_kind  backfill | incremental.
--
-- A request newer than the latest run row with no run after a grace period
-- means the runner never picked it up; that is now an error on the card, not
-- a "reload in a few minutes" hint.
-- ============================================================================

alter table context.context_connections
  add column if not exists sync_requested_at   timestamptz,
  add column if not exists sync_requested_kind context.sync_kind;

comment on column context.context_connections.sync_requested_at is
  'When a manager last asked for a sync and the event was accepted; compared with the latest context_sync_runs row to detect a request the job runner never started.';
