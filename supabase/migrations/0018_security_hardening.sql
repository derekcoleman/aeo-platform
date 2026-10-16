-- ============================================================================
-- 0018 — Security hardening: a webhook ledger that can re-drive, Worker
-- version telemetry, and a connection that cannot bind another org's site.
--
-- ops.webhook_events         + attempts / claimed_at / last_error. A route
--                            claims its row (insert, or re-claim a row whose
--                            lease lapsed and was never processed), hands the
--                            event on, and releases the claim with the error
--                            when that fails, so the provider's retry or the
--                            webhook-redrive cron can deliver it. Before this
--                            a failed send left a row that made every retry a
--                            "duplicate" and the event was lost.
-- app.sites.worker_version   what the customer's Cloudflare Worker reports in
--                            its telemetry, and when we last heard it. The
--                            Install tab asks a site still on an older Worker
--                            (or one that reports nothing: v1) to redeploy.
-- context.context_connections
--                            a connection's site must belong to the
--                            connection's org. The OAuth start route checks
--                            this; the trigger is the backstop for every other
--                            writer, members writing through RLS included.
-- ============================================================================

-- ── webhook ledger ──────────────────────────────────────────────────────────
alter table ops.webhook_events
  add column if not exists attempts   int not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_error text;
comment on column ops.webhook_events.attempts is 'Deliveries attempted: the first claim plus every re-claim by a provider retry or webhook-redrive.';
comment on column ops.webhook_events.claimed_at is 'When a handler last claimed the row. A claim older than the lease, on a row never processed, may be taken again.';

-- What webhook-redrive scans every 15 minutes.
create index if not exists webhook_events_unprocessed_idx
  on ops.webhook_events (received_at) where processed_at is null;

-- Until now nothing marked a Slack interaction processed once its event was
-- sent, so the ledger cannot tell a delivered click from a lost one. Keep the
-- old meaning for those rows (recorded = delivered) rather than re-sending
-- every historic approval click on the first re-drive.
update ops.webhook_events
  set processed_at = received_at
  where processed_at is null and provider = 'slack' and external_id like 'interaction:%';

-- ── worker version telemetry ────────────────────────────────────────────────
alter table app.sites
  add column if not exists worker_version text,
  add column if not exists worker_seen_at timestamptz;
comment on column app.sites.worker_version is 'Version the customer''s Cloudflare Worker reports in its crawl telemetry. Null: no report yet, or a v1 Worker, which reports none.';
comment on column app.sites.worker_seen_at is 'Last telemetry post that carried worker_version (written at most once a minute).';

-- ── a connection binds a site of its own org only ───────────────────────────
-- Security invoker on purpose: a member writing through RLS sees only their
-- own org's sites, so another org's site reads as missing and is refused.
create or replace function context.connection_site_in_org()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.site_id is not null
     and not exists (select 1 from app.sites s where s.id = new.site_id and s.org_id = new.org_id) then
    raise exception 'site % does not belong to organisation %', new.site_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- A connection already bound across orgs stops syncing and says why; nothing
-- is deleted. (This update names neither column, so the trigger below would
-- not fire on it even if it existed yet.)
update context.context_connections c
  set enabled = false, status = 'error',
      last_error = 'Disabled: the connection named a project of another organisation. Reconnect it from that project.',
      updated_at = now()
  where c.site_id is not null
    and not exists (select 1 from app.sites s where s.id = c.site_id and s.org_id = c.org_id);

drop trigger if exists context_connections_site_in_org on context.context_connections;
create trigger context_connections_site_in_org
  before insert or update of site_id, org_id on context.context_connections
  for each row execute function context.connection_site_in_org();
