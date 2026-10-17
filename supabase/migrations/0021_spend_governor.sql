-- ============================================================================
-- 0021 — Spend governor: atomic budgets for model calls, SERP calls and
-- answer probes (lib/ops/spend.ts).
--
-- ops.budgets             one cap per organisation (or one of its sites),
--                         resource and period. The organisation's monthly
--                         default for each resource is created the first
--                         time it spends: llm and answer_probe from env
--                         defaults, serp from organizations.
--                         serp_monthly_budget_usd, which a trigger keeps in
--                         step when the org settings change it.
-- ops.spend_counters      per budget and period: what is spent and what is
--                         held by calls in flight. A call is admitted by one
--                         conditional update (spent + reserved < cap), so two
--                         workers racing for the last dollar cannot both get
--                         it; the strict `<` lets the one admitted call
--                         overshoot by at most its own estimate. A counter is
--                         seeded from the ledgers (ops.llm_calls,
--                         measure.serp_spend) when its period starts, so a
--                         month that began before the governor still counts.
--                         alerted_pct is the highest alert threshold already
--                         sent this period: each one goes out once.
-- ops.spend_reservations  one row per admitted call: held, then settled with
--                         the actual cost or released when the call failed.
--                         A sweeper releases holds older than 30 minutes (a
--                         worker that died mid-call) and drops closed rows
--                         after 30 days; the ledgers keep the detail.
-- ops.llm_calls           + run_id, opportunity_id (the per-article cost cap
--                         sums by it), cache token counts and stop_reason.
-- content.opportunities   + cost_cap_reset_at: when a person last reopened
--                         it. The per-article cap counts from there, so an
--                         article that hit its cap gets a fresh allowance
--                         when someone asks for it again, and only then.
-- ============================================================================

create type ops.spend_resource as enum ('llm', 'serp', 'answer_probe');

-- ── budgets ─────────────────────────────────────────────────────────────────
create table ops.budgets (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references app.organizations (id) on delete cascade,
  site_id     uuid references app.sites (id) on delete cascade,
  resource    ops.spend_resource not null,
  period      text not null default 'month',
  cap_usd     numeric(10, 2) not null,
  alert_pcts  int[] not null default '{80,100}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint budgets_period_check check (period in ('day', 'month')),
  constraint budgets_cap_check check (cap_usd >= 0),
  constraint budgets_alert_pcts_check check (0 < all (alert_pcts)),
  constraint budgets_one_per_scope unique nulls not distinct (org_id, site_id, resource, period)
);
comment on table ops.budgets is
  'Spend caps per organisation (site_id null) or site, resource and period (UTC day or month). Every applicable budget must have room before a call is made.';
comment on column ops.budgets.alert_pcts is 'Percent-of-cap thresholds at which the organisation is told, once per period each.';

create index budgets_site_idx on ops.budgets (site_id) where site_id is not null;

-- A site budget always carries its site's org, whatever the writer passed (0020's rule for controls).
create trigger budgets_org
  before insert or update of site_id, org_id on ops.budgets
  for each row execute function ops.control_org_id();

-- The org-wide monthly SERP budget is the one the organisation settings edit.
create or replace function ops.sync_serp_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update ops.budgets
    set cap_usd = new.serp_monthly_budget_usd, updated_at = now()
    where org_id = new.id and site_id is null and resource = 'serp' and period = 'month';
  return null;
end $$;

create trigger organizations_serp_budget
  after update of serp_monthly_budget_usd on app.organizations
  for each row when (old.serp_monthly_budget_usd is distinct from new.serp_monthly_budget_usd)
  execute function ops.sync_serp_budget();

-- ── counters ────────────────────────────────────────────────────────────────
create table ops.spend_counters (
  budget_id     uuid not null references ops.budgets (id) on delete cascade,
  org_id        uuid not null references app.organizations (id) on delete cascade,
  period_start  date not null,
  reserved_usd  numeric(12, 5) not null default 0,
  spent_usd     numeric(12, 5) not null default 0,
  alerted_pct   int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (budget_id, period_start)
);
comment on table ops.spend_counters is
  'Spent and held (reserved) USD per budget and period. Written only by the spend governor: reserve, settle, release, sweep.';

create index spend_counters_org_idx on ops.spend_counters (org_id, period_start desc);

-- Denormalise org_id from the budget, as the site triggers do from the site.
create or replace function ops.budget_org_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  select org_id into new.org_id from ops.budgets where id = new.budget_id;
  return new;
end $$;

create trigger spend_counters_org
  before insert or update of budget_id, org_id on ops.spend_counters
  for each row execute function ops.budget_org_id();

-- ── reservations ────────────────────────────────────────────────────────────
create table ops.spend_reservations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references app.organizations (id) on delete cascade,
  site_id     uuid references app.sites (id) on delete set null,
  resource    ops.spend_resource not null,
  -- Every budget the hold was placed on. Each one's period is the one
  -- created_at falls in, so a day and a month budget can share a hold.
  budget_ids  uuid[] not null,
  amount_usd  numeric(12, 5) not null,
  actual_usd  numeric(12, 5),
  status      text not null default 'held',
  ref         jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  constraint spend_reservations_status_check check (status in ('held', 'settled', 'released')),
  constraint spend_reservations_amount_check check (amount_usd >= 0)
);
comment on table ops.spend_reservations is
  'One hold per admitted call: settled with its actual cost, or released when the call failed or its worker died (sweeper, after 30 minutes).';

create index spend_reservations_held_idx on ops.spend_reservations (created_at) where status = 'held';
create index spend_reservations_closed_idx on ops.spend_reservations (closed_at) where status <> 'held';
create index spend_reservations_org_idx on ops.spend_reservations (org_id, created_at desc);
create index spend_reservations_site_idx on ops.spend_reservations (site_id) where site_id is not null;

-- ── model call ledger ───────────────────────────────────────────────────────
alter table ops.llm_calls
  add column if not exists run_id                      text,
  add column if not exists opportunity_id              uuid references content.opportunities (id) on delete set null,
  add column if not exists cache_creation_input_tokens int not null default 0,
  add column if not exists cache_read_input_tokens     int not null default 0,
  add column if not exists stop_reason                 text;
comment on column ops.llm_calls.run_id is 'The Inngest run the call was made in, when there was one.';
comment on column ops.llm_calls.opportunity_id is 'The opportunity (article) the call served; the per-article cost cap sums by it.';
comment on column ops.llm_calls.stop_reason is 'end_turn | max_tokens | refusal | other, as the provider reported it.';

-- The per-article cap sums by it, and deleting an opportunity sets it null.
create index if not exists llm_calls_opportunity_idx on ops.llm_calls (opportunity_id) where opportunity_id is not null;

-- ── per-article cost cap ────────────────────────────────────────────────────
alter table content.opportunities add column if not exists cost_cap_reset_at timestamptz;
comment on column content.opportunities.cost_cap_reset_at is
  'When a person last reopened this opportunity from dismissed, failed or published ("Write about this", "Refresh now"). The per-article cost cap (AEO_ARTICLE_COST_CAP_USD) counts model calls made since; null counts them all.';

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table ops.budgets enable row level security;
alter table ops.budgets force row level security;
create policy tenant_read on ops.budgets for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

alter table ops.spend_counters enable row level security;
alter table ops.spend_counters force row level security;
create policy tenant_read on ops.spend_counters for select
  using (org_id = any (app.auth_org_ids()) or app.auth_is_staff());

-- Holds carry call references (queries, task keys); staff only.
alter table ops.spend_reservations enable row level security;
alter table ops.spend_reservations force row level security;
create policy staff_read on ops.spend_reservations for select using (app.auth_is_staff());

revoke all on ops.budgets, ops.spend_counters, ops.spend_reservations from renderer;
