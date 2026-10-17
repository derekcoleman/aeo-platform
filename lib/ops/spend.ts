import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { appDatabaseUrl } from "@/lib/db/env";
import { BUDGET_CAP_MAX_USD, ORG_SERP_BUDGET_MAX_USD } from "./spend-limits";

/**
 * The spend governor (ops.budgets / ops.spend_counters /
 * ops.spend_reservations, migration 0021). Every paid call — a model call, a
 * SERP call, an answer probe — first reserves its estimated cost against
 * every budget that covers it (the organisation's, and a project's when one
 * is set), then settles with what it actually cost, or releases the hold
 * when it failed. Admission is one conditional update per budget
 * (spent + reserved < cap) inside one transaction, so two workers racing for
 * the last dollar cannot both get it, and a refused call costs nothing.
 *
 * The organisation's monthly default for a resource is created the first
 * time it spends: llm and answer_probe from env defaults, serp from the
 * org's own setting (organizations.serp_monthly_budget_usd, kept in step by
 * trigger). Each alert threshold (80% and 100% by default) is told to the org
 * once per period; 100% also sends ops/budget.exceeded.
 *
 * Without a database (unit tests on fake SQL), or with AEO_SPEND_GOVERNOR=off,
 * the governor is a no-op that admits everything and records nothing.
 */

export type SpendResource = "llm" | "serp" | "answer_probe";
export type BudgetPeriod = "day" | "month";

export const RESOURCE_LABEL: Record<SpendResource, string> = {
  llm: "Model",
  serp: "SERP",
  answer_probe: "AI answer probe",
};

/** Monthly caps an organisation starts with; serp's is the org's own setting. */
export const DEFAULT_LLM_MONTHLY_BUDGET_USD = 200;
export const DEFAULT_ANSWER_PROBE_MONTHLY_BUDGET_USD = 25;
/** The largest cap ops.budgets.cap_usd (numeric(10, 2)) holds; an env default above it means "as high as it goes". */
export const MAX_CAP_USD = 99_999_999.99;

/**
 * The task key answer probes are ledgered under in ops.llm_calls. Their spend
 * is the answer_probe budget's, so a new period's model (llm) counter leaves
 * those rows out and the probe counter starts from them.
 */
export const ANSWER_PROBE_TASK_KEY = "answers.probe";

/** A hold older than this belonged to a worker that died mid-call; the sweeper gives it back. */
export const RESERVATION_TTL_MINUTES = 30;
/** Settled and released holds are dropped after this; the ledgers keep the detail and the counters the totals. */
export const RESERVATION_RETENTION_DAYS = 30;

type Env = Record<string, string | undefined>;

export class BudgetExceededError extends Error {
  constructor(
    public readonly resource: SpendResource,
    public readonly orgId: string,
    public readonly spentUsd: number,
    public readonly limitUsd: number,
    public readonly siteId: string | null = null,
    public readonly period: BudgetPeriod = "month",
  ) {
    super(`${resource} budget exceeded for ${siteId ? `site ${siteId}` : `org ${orgId}`}: spent ${spentUsd.toFixed(2)} of ${limitUsd.toFixed(2)} USD ${period === "day" ? "today" : "this month"}`);
    this.name = "BudgetExceededError";
  }
}

export interface SpendRequest {
  orgId: string;
  siteId?: string | null;
  resource: SpendResource;
  /** Upper bound of what the call can cost; held on every covering budget until settled. */
  estimateUsd: number;
  /** What the hold is for (task, query, run). Staff read it when a hold is swept. */
  ref?: Record<string, unknown>;
}

export interface Reservation {
  /** Null from the no-op governor: nothing was held. */
  id: string | null;
  orgId: string;
  siteId: string | null;
  resource: SpendResource;
  estimateUsd: number;
}

export interface BudgetAlert {
  orgId: string;
  siteId: string | null;
  /** The project's domain for a project budget. */
  siteDomain: string | null;
  resource: SpendResource;
  period: BudgetPeriod;
  periodStart: string;
  /** The threshold crossed (a value of alert_pcts), not the exact share. */
  pct: number;
  spentUsd: number;
  capUsd: number;
}

export interface SpendGovernor {
  /** False for the no-op governor. */
  readonly enabled: boolean;
  /** Throws BudgetExceededError when any covering budget has no room left. */
  reserve(req: SpendRequest): Promise<Reservation>;
  /** Record what the call cost. Idempotent; a hold the sweeper already released still counts its spend. */
  settle(res: Reservation, actualUsd: number): Promise<void>;
  /** The call failed and cost nothing: give the hold back. Idempotent. */
  release(res: Reservation): Promise<void>;
}

/** USD to the ledger's precision (numeric(12, 5)), never negative. */
export function roundUsd(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e5) / 1e5 : 0;
}

/**
 * A USD amount from env. A blank, malformed or negative value means unset:
 * .env files list these as `NAME=`, and Number("") is 0.
 */
export function usdFromEnv(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The cap a new organisation-wide monthly budget starts at; null for serp,
 * which is the org's own setting. Held to MAX_CAP_USD: a larger value would
 * overflow the column and fail every call of an org without a budget yet.
 */
export function defaultMonthlyCapUsd(resource: SpendResource, env: Env = process.env): number | null {
  if (resource === "llm") return Math.min(MAX_CAP_USD, usdFromEnv("AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD", DEFAULT_LLM_MONTHLY_BUDGET_USD, env));
  if (resource === "answer_probe") return Math.min(MAX_CAP_USD, usdFromEnv("AEO_DEFAULT_ANSWER_PROBE_MONTHLY_BUDGET_USD", DEFAULT_ANSWER_PROBE_MONTHLY_BUDGET_USD, env));
  return null;
}

/** The highest threshold `spentUsd` has reached that was not already told this period, if any. */
export function crossedThreshold(spentUsd: number, capUsd: number, alertPcts: number[], alertedPct: number): number | null {
  if (!(capUsd > 0)) return null;
  const share = (spentUsd / capUsd) * 100;
  const reached = alertPcts.filter((p) => p > alertedPct && share >= p);
  return reached.length ? Math.max(...reached) : null;
}

export function noopGovernor(): SpendGovernor {
  return {
    enabled: false,
    async reserve(req) {
      return { id: null, orgId: req.orgId, siteId: req.siteId ?? null, resource: req.resource, estimateUsd: req.estimateUsd };
    },
    async settle() {},
    async release() {},
  };
}

/** Deadlock and serialization failure: Postgres aborted one side of a lock conflict, and running it again is safe. */
const CONFLICT_CODES = new Set(["40P01", "40001"]);
const CONFLICT_ATTEMPTS = 3;

/**
 * Run a transaction again when Postgres aborted it over a lock conflict.
 * Reserve and settle lock several counter rows (an org's and a project's) in
 * whatever order the plan gives, so two of them can deadlock. A settle that
 * fails here would leave a paid call uncounted, so it gets more than one go.
 */
export async function retryOnConflict<T>(fn: () => Promise<T>, attempts = CONFLICT_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (attempt >= attempts || typeof code !== "string" || !CONFLICT_CODES.has(code)) throw e;
    }
  }
}

export function spendGovernorEnabled(env: Env = process.env): boolean {
  return env.AEO_SPEND_GOVERNOR?.trim().toLowerCase() !== "off" && appDatabaseUrl(env) !== null;
}

/** The governor every caller gets unless it passes one: Postgres when a database is configured, else the no-op. */
export function defaultSpendGovernor(sql?: postgres.Sql, env: Env = process.env): SpendGovernor {
  return spendGovernorEnabled(env) ? postgresSpendGovernor(sql ?? appDb(), { env }) : noopGovernor();
}

export interface PostgresGovernorOptions {
  env?: Env;
  /** Told once per threshold per period. Defaults to the org's alert channels plus ops/budget.exceeded at 100%. */
  onAlert?: (alert: BudgetAlert) => Promise<void>;
}

interface CounterRow {
  budget_id: string;
  period_start: string;
  spent_usd: number;
  alerted_pct: number;
  cap_usd: number;
  alert_pcts: number[];
  org_id: string;
  site_id: string | null;
  site_domain: string | null;
  resource: SpendResource;
  period: BudgetPeriod;
}

export function postgresSpendGovernor(sql: postgres.Sql = appDb(), opts: PostgresGovernorOptions = {}): SpendGovernor {
  const env = opts.env ?? process.env;
  const onAlert = opts.onAlert ?? alertOrg;

  /** The org-wide monthly default, created on first use and kept even when the call is refused. */
  async function ensureDefaultBudget(orgId: string, resource: SpendResource): Promise<void> {
    await sql`
      insert into ops.budgets (org_id, resource, period, cap_usd)
      select o.id, ${resource}::ops.spend_resource, 'month',
             case when ${resource}::text = 'serp' then o.serp_monthly_budget_usd else ${defaultMonthlyCapUsd(resource, env)}::numeric end
      from app.organizations o
      where o.id = ${orgId}
        and not exists (select 1 from ops.budgets b
                        where b.org_id = o.id and b.site_id is null and b.resource = ${resource}::ops.spend_resource and b.period = 'month')
      on conflict do nothing`;
  }

  /**
   * This period's counter for every budget covering the call, as `db` sees
   * now(). A counter starts from what the ledgers already hold for its
   * period, so a month that began before the governor (or with it off) still
   * counts. Answer probes are ledgered in ops.llm_calls as well, under their
   * own task key, and count toward their own budget, not the model one.
   */
  async function ensureCounters(db: postgres.Sql, orgId: string, siteId: string | null, resource: SpendResource): Promise<void> {
    await db`
      insert into ops.spend_counters (budget_id, org_id, period_start, spent_usd)
      select b.id, b.org_id, p.day,
             case b.resource
               when 'llm' then (select coalesce(sum(l.cost_usd), 0) from ops.llm_calls l
                                where l.org_id = b.org_id and (b.site_id is null or l.site_id = b.site_id)
                                  and l.task_key <> ${ANSWER_PROBE_TASK_KEY}
                                  and l.created_at >= p.day::timestamp at time zone 'utc')
               when 'answer_probe' then (select coalesce(sum(l.cost_usd), 0) from ops.llm_calls l
                                         where l.org_id = b.org_id and (b.site_id is null or l.site_id = b.site_id)
                                           and l.task_key = ${ANSWER_PROBE_TASK_KEY}
                                           and l.created_at >= p.day::timestamp at time zone 'utc')
               when 'serp' then (select coalesce(sum(s.cost_usd), 0) from measure.serp_spend s
                                 where s.org_id = b.org_id and not s.cached and (b.site_id is null or s.site_id = b.site_id)
                                   and s.at >= p.day::timestamp at time zone 'utc')
               else 0
             end
      from ops.budgets b
      cross join lateral (select date_trunc(b.period, now() at time zone 'utc')::date as day) p
      where b.org_id = ${orgId} and b.resource = ${resource}::ops.spend_resource and (b.site_id is null or b.site_id = ${siteId}::uuid)
        and not exists (select 1 from ops.spend_counters c where c.budget_id = b.id and c.period_start = p.day)
      on conflict do nothing`;
  }

  return {
    enabled: true,

    async reserve(req) {
      const siteId = req.siteId ?? null;
      const estimate = roundUsd(req.estimateUsd);
      await ensureDefaultBudget(req.orgId, req.resource);
      // Committed on its own, so a refused call still leaves this period's counter for Ops to show.
      await ensureCounters(sql, req.orgId, siteId, req.resource);
      const id = await retryOnConflict(() => sql.begin(async (tx) => {
        // Again under the admission's own now(): when a UTC day or month turned
        // over since the line above, the new period's counters are made here,
        // so no covering budget drops out of the check below.
        await ensureCounters(tx as unknown as postgres.Sql, req.orgId, siteId, req.resource);
        const budgets = await tx<{ budget_id: string; site_id: string | null; period: BudgetPeriod; cap_usd: number; spent_usd: number }[]>`
          select b.id as budget_id, b.site_id, b.period, b.cap_usd::float as cap_usd, c.spent_usd::float as spent_usd
          from ops.budgets b
          join ops.spend_counters c on c.budget_id = b.id and c.period_start = date_trunc(b.period, now() at time zone 'utc')::date
          where b.org_id = ${req.orgId} and b.resource = ${req.resource}::ops.spend_resource and (b.site_id is null or b.site_id = ${siteId}::uuid)`;
        if (budgets.length === 0) throw new Error(`no ${req.resource} budget for org ${req.orgId} (unknown organisation?)`);
        // The admission: one row lock per budget. A racer blocked on the lock
        // re-checks the condition against the committed row, so the last
        // dollar goes to one of them.
        const held = await tx<{ budget_id: string }[]>`
          update ops.spend_counters c
          set reserved_usd = c.reserved_usd + ${estimate}, updated_at = now()
          from ops.budgets b
          where b.id = c.budget_id and b.id = any (${budgets.map((b) => b.budget_id)}::uuid[])
            and c.period_start = date_trunc(b.period, now() at time zone 'utc')::date
            and c.spent_usd + c.reserved_usd < b.cap_usd
          returning c.budget_id`;
        const refused = budgets.find((b) => !held.some((h) => h.budget_id === b.budget_id));
        // Throwing rolls back the holds already placed on the other budgets.
        if (refused) throw new BudgetExceededError(req.resource, req.orgId, refused.spent_usd, refused.cap_usd, refused.site_id, refused.period);
        const [row] = await tx<{ id: string }[]>`
          insert into ops.spend_reservations (org_id, site_id, resource, budget_ids, amount_usd, ref)
          values (${req.orgId}, ${siteId}, ${req.resource}::ops.spend_resource, ${held.map((h) => h.budget_id)}::uuid[], ${estimate}, ${tx.json((req.ref ?? {}) as never)})
          returning id`;
        return row!.id;
      }));
      return { id: id as string, orgId: req.orgId, siteId, resource: req.resource, estimateUsd: estimate };
    },

    async settle(res, actualUsd) {
      if (!res.id) return;
      const actual = roundUsd(actualUsd);
      // Safe to run again: a hold already settled is left alone.
      const alerts = (await retryOnConflict(() => sql.begin(async (tx) => {
        const [prev] = await tx<{ status: string; amount_usd: string }[]>`
          select status, amount_usd::text as amount_usd from ops.spend_reservations where id = ${res.id} for update`;
        if (!prev || prev.status === "settled") return [];
        // A hold the sweeper already released gave its estimate back; only the spend is left to count.
        const held = prev.status === "held" ? prev.amount_usd : "0";
        await tx`update ops.spend_reservations set status = 'settled', actual_usd = ${actual}, closed_at = now() where id = ${res.id}`;
        const counters = await tx<CounterRow[]>`
          update ops.spend_counters c
          set reserved_usd = greatest(0, c.reserved_usd - ${held}::numeric), spent_usd = c.spent_usd + ${actual}, updated_at = now()
          from ops.budgets b, ops.spend_reservations r
          where r.id = ${res.id} and b.id = any (r.budget_ids) and c.budget_id = b.id
            and c.period_start = date_trunc(b.period, r.created_at at time zone 'utc')::date
          returning c.budget_id, c.period_start::text as period_start, c.spent_usd::float as spent_usd, c.alerted_pct,
                    b.cap_usd::float as cap_usd, b.alert_pcts, b.org_id, b.site_id, b.resource::text as resource, b.period,
                    (select s.canonical_domain from app.sites s where s.id = b.site_id) as site_domain`;
        const out: BudgetAlert[] = [];
        for (const c of counters) {
          const pct = crossedThreshold(c.spent_usd, c.cap_usd, c.alert_pcts, c.alerted_pct);
          if (pct === null) continue;
          // Claimed under the row lock this transaction holds: each threshold is told once per period.
          const claimed = await tx`
            update ops.spend_counters set alerted_pct = ${pct}
            where budget_id = ${c.budget_id} and period_start = ${c.period_start}::date and alerted_pct < ${pct}
            returning budget_id`;
          if (claimed.length) {
            out.push({ orgId: c.org_id, siteId: c.site_id, siteDomain: c.site_domain, resource: c.resource, period: c.period, periodStart: c.period_start, pct, spentUsd: c.spent_usd, capUsd: c.cap_usd });
          }
        }
        return out;
      }))) as BudgetAlert[];
      // After commit: a rolled-back settle must not have told anyone. Best effort, like every notification.
      for (const a of alerts) {
        await onAlert(a).catch((e) => console.warn(`[spend] alert for org ${a.orgId} failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async release(res) {
      if (!res.id) return;
      await sql`
        with r as (
          update ops.spend_reservations set status = 'released', closed_at = now()
          where id = ${res.id} and status = 'held'
          returning budget_ids, amount_usd, created_at
        )
        update ops.spend_counters c
        set reserved_usd = greatest(0, c.reserved_usd - r.amount_usd), updated_at = now()
        from r, ops.budgets b
        where b.id = any (r.budget_ids) and c.budget_id = b.id
          and c.period_start = date_trunc(b.period, r.created_at at time zone 'utc')::date`;
    },
  };
}

/**
 * Release holds older than `olderThanMinutes` (their worker died between
 * reserve and settle) and drop closed holds past retention. A settle that
 * arrives after its hold was swept still counts the spend.
 */
export async function sweepSpendReservations(
  opts: { olderThanMinutes?: number; retentionDays?: number } = {},
  sql: postgres.Sql = appDb(),
): Promise<{ released: number; purged: number }> {
  const [row] = await sql<{ released: number }[]>`
    with r as (
      update ops.spend_reservations set status = 'released', closed_at = now()
      where status = 'held' and created_at < now() - make_interval(mins => ${opts.olderThanMinutes ?? RESERVATION_TTL_MINUTES})
      returning budget_ids, amount_usd, created_at
    ), held as (
      -- One update per counter: several holds on one counter are summed first.
      select b.id as budget_id, date_trunc(b.period, r.created_at at time zone 'utc')::date as period_start, sum(r.amount_usd) as amount
      from r join ops.budgets b on b.id = any (r.budget_ids)
      group by 1, 2
    ), freed as (
      update ops.spend_counters c
      set reserved_usd = greatest(0, c.reserved_usd - h.amount), updated_at = now()
      from held h
      where c.budget_id = h.budget_id and c.period_start = h.period_start
      returning 1
    )
    select (select count(*) from r)::int as released`;
  const purged = await sql`
    delete from ops.spend_reservations
    where status <> 'held' and closed_at < now() - make_interval(days => ${opts.retentionDays ?? RESERVATION_RETENTION_DAYS})`;
  return { released: row?.released ?? 0, purged: purged.count };
}

export interface BudgetRow {
  id: string;
  org_id: string;
  org_name: string;
  site_id: string | null;
  site_name: string | null;
  resource: SpendResource;
  period: BudgetPeriod;
  cap_usd: number;
  spent_usd: number;
  reserved_usd: number;
  alerted_pct: number;
  period_start: string;
}

/** Every budget with this period's counter (zero before the first call of the period); one org's with `orgId`. */
export async function listBudgets(scope: { orgId?: string | null } = {}, sql: postgres.Sql = appDb()): Promise<BudgetRow[]> {
  return sql<BudgetRow[]>`
    select b.id, b.org_id, o.name as org_name, b.site_id, s.name as site_name, b.resource::text as resource, b.period,
           b.cap_usd::float as cap_usd, coalesce(c.spent_usd, 0)::float as spent_usd, coalesce(c.reserved_usd, 0)::float as reserved_usd,
           coalesce(c.alerted_pct, 0) as alerted_pct, p.day::text as period_start
    from ops.budgets b
    cross join lateral (select date_trunc(b.period, now() at time zone 'utc')::date as day) p
    join app.organizations o on o.id = b.org_id
    left join app.sites s on s.id = b.site_id
    left join ops.spend_counters c on c.budget_id = b.id and c.period_start = p.day
    where (${scope.orgId ?? null}::uuid is null or b.org_id = ${scope.orgId ?? null}::uuid)
    order by o.name, b.resource, s.name nulls first, b.period`;
}

export type SetBudgetCapResult = { ok: true; orgId: string; resource: SpendResource; before: number } | { ok: false; error: string };

/**
 * Staff: set one budget's cap, audited. The org-wide monthly SERP budget is
 * the organisation's own setting, so that one is written there and the
 * trigger carries it over, within the limit the org settings form allows;
 * the org settings and the governor never disagree.
 */
export async function setBudgetCap(budgetId: string, capUsd: number, by: string, sql: postgres.Sql = appDb()): Promise<SetBudgetCapResult> {
  const cap = Math.round(capUsd * 100) / 100;
  if (!(cap >= 0 && cap <= BUDGET_CAP_MAX_USD)) return { ok: false, error: `Enter a cap between 0 and ${BUDGET_CAP_MAX_USD} USD.` };
  return sql.begin(async (tx) => {
    const [b] = await tx<{ org_id: string; site_id: string | null; resource: SpendResource; period: BudgetPeriod; cap_usd: number }[]>`
      select org_id, site_id, resource::text as resource, period, cap_usd::float as cap_usd from ops.budgets where id = ${budgetId} for update`;
    if (!b) return { ok: false, error: "Budget not found." };
    if (isOrgSerpBudget(b)) {
      if (cap > ORG_SERP_BUDGET_MAX_USD) return { ok: false, error: `The organisation's monthly SERP budget goes up to ${ORG_SERP_BUDGET_MAX_USD} USD (its settings form allows no more).` };
      await tx`update app.organizations set serp_monthly_budget_usd = ${cap} where id = ${b.org_id}`;
    } else {
      await tx`update ops.budgets set cap_usd = ${cap}, updated_at = now() where id = ${budgetId}`;
    }
    await tx`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, before, after)
      values (${b.org_id}, ${by}, 'ops.budget_cap', 'budget', ${budgetId},
              ${tx.json({ resource: b.resource, period: b.period, siteId: b.site_id, capUsd: b.cap_usd } as never)},
              ${tx.json({ resource: b.resource, period: b.period, siteId: b.site_id, capUsd: cap } as never)})`;
    return { ok: true, orgId: b.org_id, resource: b.resource, before: b.cap_usd };
  }) as Promise<SetBudgetCapResult>;
}

/** The org-wide monthly SERP budget: the one the organisation settings edit. */
export function isOrgSerpBudget(b: { resource: SpendResource; site_id: string | null; period: BudgetPeriod }): boolean {
  return b.resource === "serp" && b.site_id === null && b.period === "month";
}

/** The most a budget's cap can be set to in Ops → Spend. */
export function budgetCapMaxUsd(b: { resource: SpendResource; site_id: string | null; period: BudgetPeriod }): number {
  return isOrgSerpBudget(b) ? ORG_SERP_BUDGET_MAX_USD : BUDGET_CAP_MAX_USD;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** When a period's spend starts over (UTC): the next day or the first of the next month. */
export function periodEnd(periodStart: string, period: BudgetPeriod): Date {
  const d = new Date(`${periodStart}T00:00:00Z`);
  if (period === "day") d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return d;
}

export function budgetAlertText(a: BudgetAlert): { subject: string; text: string } {
  const what = `${RESOURCE_LABEL[a.resource]} budget${a.siteDomain ? ` for ${a.siteDomain}` : ""}`;
  const cap = `${usd(a.capUsd)} ${a.period === "day" ? "daily" : "monthly"} cap`;
  const resumes = periodEnd(a.periodStart, a.period).toISOString().slice(0, 10);
  if (a.pct >= 100) {
    return {
      subject: `${what} reached`,
      text: `${what} reached: ${usd(a.spentUsd)} of the ${cap}. New ${a.resource === "llm" ? "model calls" : a.resource === "serp" ? "SERP calls" : "answer probes"} are refused until ${resumes} (UTC) or until the cap is raised.`,
    };
  }
  return {
    subject: `${what} at ${a.pct}%`,
    text: `${what} at ${a.pct}%: ${usd(a.spentUsd)} of the ${cap} used. Calls stop at 100% until ${resumes} (UTC) or until the cap is raised.`,
  };
}

/**
 * The default alert: the org's alerts channel and owners (notifyOrg), plus
 * ops/budget.exceeded at 100% for anything that should react to it. Loaded
 * on first use: the governor sits under every model and SERP call, and the
 * notifier pulls in every connector.
 */
async function alertOrg(a: BudgetAlert): Promise<void> {
  const [{ notifyOrg }, { inngest, opsBudgetExceeded }, { inngestConfigured }] = await Promise.all([
    import("@/lib/notify/org"),
    import("@/lib/inngest/client"),
    import("@/lib/jobs/runner"),
  ]);
  const { subject, text } = budgetAlertText(a);
  await notifyOrg(a.orgId, text, { subject });
  if (a.pct >= 100 && inngestConfigured()) {
    await inngest.send(opsBudgetExceeded.create({ orgId: a.orgId, siteId: a.siteId, resource: a.resource, period: a.period, periodStart: a.periodStart, capUsd: a.capUsd, spentUsd: a.spentUsd }));
  }
}
