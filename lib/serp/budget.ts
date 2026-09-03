import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { SerpMethod } from "./cache";
import type { SerpProviderName } from "./types";

/**
 * Per-org spend guard, enforced in the client before the call — the same
 * shape the ModelRouter uses. SERP spend recurs per query per site and
 * compounds faster than model spend, so "we noticed on the invoice" is not a
 * control. Every paid or cached call also lands in measure.serp_spend so
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

export interface BudgetGuard {
  /** Throws BudgetExceededError when the month's spend plus `costUsd` would exceed the org's limit. */
  reserve(orgId: string, costUsd: number): Promise<void>;
  record(rec: SpendRecord): Promise<void>;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly spentUsd: number,
    public readonly limitUsd: number,
  ) {
    super(`serp budget exceeded for org ${orgId}: spent ${spentUsd.toFixed(2)} of ${limitUsd.toFixed(2)} USD this month`);
    this.name = "BudgetExceededError";
  }
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
      if (cur + costUsd > limit) throw new BudgetExceededError(orgId, cur, limit);
    },
    async record(rec) {
      records.push(rec);
      if (!rec.cached) spent[rec.orgId] = (spent[rec.orgId] ?? 0) + rec.costUsd;
    },
  };
}

export function postgresBudget(sql: postgres.Sql = appDb()): BudgetGuard {
  return {
    async reserve(orgId, costUsd) {
      const [row] = await sql<{ limit_usd: string; spent_usd: string }[]>`
        select o.serp_monthly_budget_usd as limit_usd,
               coalesce((select sum(cost_usd) from measure.serp_spend s
                          where s.org_id = o.id and not s.cached
                            and s.at >= date_trunc('month', now())), 0) as spent_usd
        from app.organizations o where o.id = ${orgId}`;
      if (!row) throw new Error(`unknown org ${orgId}`);
      const limit = Number(row.limit_usd);
      const spent = Number(row.spent_usd);
      if (spent + costUsd > limit) throw new BudgetExceededError(orgId, spent, limit);
    },
    async record(rec) {
      await sql`
        insert into measure.serp_spend (org_id, site_id, provider, method, query, cost_usd, cached)
        values (${rec.orgId}, ${rec.siteId}, ${rec.provider}, ${rec.method}, ${rec.query}, ${rec.costUsd}, ${rec.cached})`;
    },
  };
}
