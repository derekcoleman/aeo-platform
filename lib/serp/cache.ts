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

/** What was paid for: a SERP, autocomplete, an answer probe, or a domain's ranked keywords from DataForSEO Labs. */
export type SerpMethod = "autocomplete" | "serp" | "answer" | "labs.ranked_keywords";

export interface SerpCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, meta: CacheMeta): Promise<void>;
}

export interface CacheMeta {
  /** A SERP vendor, or OpenRouter for an answer probe. */
  provider: SerpProviderName | "openrouter";
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

/**
 * An answer probe's key: the engine, the model with how it searched
 * (`openai/gpt-5-mini+web:native`), which sample and which wording of the
 * prompt, the day and the prompt. Shared across tenants like a SERP key: an
 * engine's answer to a prompt does not depend on who asked, and another run
 * the same day reads it instead of paying for another. The day is the run's,
 * and the step that paid keeps its own record apart (lib/answers/sample.ts).
 */
export function answerCacheKey(engine: string, model: string, sampleIndex: number, paraphraseId: string | null, q: string, day: string): string {
  const query = q.trim().toLowerCase().replace(/\s+/g, " ");
  return `openrouter|answer|${engine}|${model}|s${sampleIndex}|${paraphraseId ?? "-"}|${day}|${query}`;
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
