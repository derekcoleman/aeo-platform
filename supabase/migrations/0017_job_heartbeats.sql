-- ============================================================================
-- 0017 — Job-runner heartbeats: proof that Inngest executes functions
-- against this database, so the setup checklist can tell "the endpoint
-- answers" from "functions actually run".
--
-- ops.job_heartbeats   one row per key, overwritten on every beat:
--   cron            written by site-health-monitor, which Inngest schedules
--                   every five minutes; a stale or missing row means the
--                   scheduler is not running this app.
--   ping:sent       written by Ops → Setup → "Send a test event" together
--                   with a nonce, right after the event was accepted.
--   ping:received   written by the ops-ping function when the event arrives;
--                   a matching nonce proves the event key, the sync and the
--                   invocation path end to end.
-- ============================================================================

create table ops.job_heartbeats (
  key        text primary key,
  seen_at    timestamptz not null default now(),
  deployment text,                                   -- VERCEL_DEPLOYMENT_ID of the writer
  detail     jsonb not null default '{}'::jsonb
);

comment on table ops.job_heartbeats is
  'Last time the job runner did something observable here, per key (cron, ping:sent, ping:received). Read by the Ops → Setup checklist.';

alter table ops.job_heartbeats enable row level security;
alter table ops.job_heartbeats force row level security;
create policy staff_read on ops.job_heartbeats for select using (app.auth_is_staff());

revoke all on ops.job_heartbeats from renderer;
