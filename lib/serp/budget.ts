import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { BudgetExceededError, defaultSpendGovernor, type Reservation, type SpendGovernor } from "@/lib/ops/spend";
import type { SerpMethod } from "./cache";
import type { SerpProviderName } from "./types";

export { BudgetExceededError } from "@/lib/ops/spend";

/**
 * Per-org spend guard, enforced in the client before the call — the same
 * spend governor the model calls go through (lib/ops/spend.ts, resource
 * `serp`). SERP spend recurs per query per site and compounds faster than
 * model spend, so "we noticed on the invoice" is not a control. Every paid
 * or cached call also lands in measure.serp_spend so
 * cost-per-site-per-month is one query.
 */

export interface SpendRecord {
  orgId: string;
  siteId: string | null;
  provider: SerpProviderName;
  method: SerpMethod;
  query: string;
  costUsd: number;
  cached: boolean;
}

export interface SpendMeta {
  siteId: string | null;
  provider: SerpProviderName;
  method: SerpMethod;
  query: string;
}

export interface BudgetGuard {
  /**
   * Holds `costUsd` (the call's estimate) against the org's SERP budget;
   * throws BudgetExceededError when it has no room. The hold comes back to
   * `record` (settled at the actual cost) or `release` (the call failed).
   * Null when this guard keeps no holds.
   */
  reserve(orgId: string, costUsd: number, meta: SpendMeta): Promise<Reservation | null>;
  release(reservation: Reservation | null): Promise<void>;
  record(rec: SpendRecord, reservation?: Reservation | null): Promise<void>;
}

export function memoryBudget(limits: Record<string, number>, defaultLimit = 25): BudgetGuard & { spent: Record<string, number>; records: SpendRecord[] } {
  const spent: Record<string, number> = {};
  const records: SpendRecord[] = [];
  return {
    spent,
    records,
    async reserve(orgId, costUsd) {
      const limit = limits[orgId] ?? defaultLimit;
      const cur = spent[orgId] ?? 0;
      if (cur + costUsd > limit) throw new BudgetExceededError("serp", orgId, cur, limit);
      return null;
    },
    async release() {},
    async record(rec) {
      records.push(rec);
      if (!rec.cached) spent[rec.orgId] = (spent[rec.orgId] ?? 0) + rec.costUsd;
    },
  };
}

/**
 * The production guard: holds and settles through the spend governor and
 * writes the ledger. With the governor off (AEO_SPEND_GOVERNOR=off) it falls
 * back to the month-to-date check it made before the governor existed, so
 * SERP spend is never unbounded.
 */
export function postgresBudget(sql: postgres.Sql = appDb(), governor: SpendGovernor = defaultSpendGovernor(sql)): BudgetGuard {
  return {
    async reserve(orgId, costUsd, meta) {
      if (governor.enabled) {
        return governor.reserve({ orgId, siteId: meta.siteId, resource: "serp", estimateUsd: costUsd, ref: { provider: meta.provider, method: meta.method, query: meta.query } });
      }
      const [row] = await sql<{ limit_usd: string; spent_usd: string }[]>`
        select o.serp_monthly_budget_usd as limit_usd,
               coalesce((select sum(cost_usd) from measure.serp_spend s
                          where s.org_id = o.id and not s.cached
                            and s.at >= date_trunc('month', now())), 0) as spent_usd
        from app.organizations o where o.id = ${orgId}`;
      if (!row) throw new Error(`unknown org ${orgId}`);
      const limit = Number(row.limit_usd);
      const spent = Number(row.spent_usd);
      if (spent + costUsd > limit) throw new BudgetExceededError("serp", orgId, spent, limit);
      return null;
    },
    async release(reservation) {
      if (reservation) await governor.release(reservation);
    },
    async record(rec, reservation) {
      // Counted first: the call is paid for whether or not the ledger row
      // lands. The row lands even when counting failed: the next period's
      // counter starts from the ledger.
      try {
        if (reservation) await governor.settle(reservation, rec.costUsd);
      } finally {
        await sql`
          insert into measure.serp_spend (org_id, site_id, provider, method, query, cost_usd, cached)
          values (${rec.orgId}, ${rec.siteId}, ${rec.provider}, ${rec.method}, ${rec.query}, ${rec.costUsd}, ${rec.cached})`;
      }
    },
  };
}
