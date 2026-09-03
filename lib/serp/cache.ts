import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { SerpProviderName, SerpQuery } from "./types";

/**
 * SERP responses are cached by (provider, method, query, locale, device, day).
 * A day is the finest grain that is still meaningful — Google's results for a
 * query do not change enough intra-day to justify paying twice — and it is
 * what makes the tiered refresh cadence (daily / weekly / monthly) honest:
 * the cadence decides when we pay, the cache guarantees we pay at most once.
 */

export type SerpMethod = "autocomplete" | "serp";

export interface SerpCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, meta: CacheMeta): Promise<void>;
}

export interface CacheMeta {
  provider: SerpProviderName;
  method: SerpMethod;
  query: SerpQuery;
  day: string;
  costUsd: number;
}

export function dayOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function cacheKey(provider: SerpProviderName, method: SerpMethod, q: SerpQuery, day: string): string {
  const query = q.query.trim().toLowerCase().replace(/\s+/g, " ");
  return `${provider}|${method}|${q.locale.country.toLowerCase()}-${q.locale.language.toLowerCase()}|${q.device}|${day}|${query}`;
}

export function memoryCache(): SerpCache & { size: number } {
  const store = new Map<string, unknown>();
  return {
    get size() {
      return store.size;
    },
    async get<T>(key: string) {
      return (store.get(key) as T | undefined) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

export function postgresCache(sql: postgres.Sql = appDb()): SerpCache {
  return {
    async get<T>(key: string) {
      const rows = await sql<{ payload: T }[]>`select payload from measure.serp_cache where key = ${key}`;
      return rows[0]?.payload ?? null;
    },
    async set(key, value, meta) {
      await sql`
        insert into measure.serp_cache (key, provider, method, query, locale, device, day, payload, cost_usd)
        values (${key}, ${meta.provider}, ${meta.method}, ${meta.query.query},
                ${`${meta.query.locale.country}-${meta.query.locale.language}`}, ${meta.query.device},
                ${meta.day}, ${sql.json(value as never)}, ${meta.costUsd})
        on conflict (key) do update set payload = excluded.payload, fetched_at = now()`;
    },
  };
}
