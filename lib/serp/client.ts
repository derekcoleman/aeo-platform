import { cacheKey, dayOf, memoryCache, postgresCache, type SerpCache } from "./cache";
import { memoryBudget, postgresBudget, type BudgetGuard } from "./budget";
import { dataForSeoProvider } from "./dataforseo";
import { aioVendorPreference, dataForSeoConfigured, serpApiKey } from "./env";
import { serpApiProvider } from "./serpapi";
import type { AiOverview, AutocompleteResult, PaaItem, SerpProvider, SerpProviderName, SerpQuery, SerpResult } from "./types";

/**
 * The client the rest of the product calls. It routes by purpose — bulk to
 * the cheap provider, AI Overview extraction to the high-fidelity one — and
 * wraps every call in the day cache and the per-org budget guard: a cache
 * miss holds its estimate before the call, settles at the vendor's reported
 * cost, and gives the hold back when the call throws.
 */

export interface SerpTenant {
  orgId: string;
  siteId?: string | null;
}

export interface SerpClientOptions {
  /** Cheap provider for autocomplete / PAA / rank tracking. */
  bulk: SerpProvider;
  /** High-fidelity provider for AI Overview citations. Defaults to `bulk`. */
  aio?: SerpProvider;
  cache?: SerpCache;
  budget?: BudgetGuard;
  now?: () => Date;
  /** Estimated cost used for the budget check before a call is made. */
  estimate?: Partial<Record<SerpProviderName, { serp: number; autocomplete: number }>>;
}

export interface SerpClient {
  autocomplete(q: SerpQuery, t: SerpTenant): Promise<AutocompleteResult & { cached: boolean }>;
  paa(q: SerpQuery, t: SerpTenant): Promise<PaaItem[]>;
  serp(q: SerpQuery, t: SerpTenant): Promise<SerpResult & { cached: boolean }>;
  /** Full SERP from the AIO provider: citations plus organic/PAA in one paid call. */
  aioSerp(q: SerpQuery, t: SerpTenant): Promise<SerpResult & { cached: boolean }>;
  aiOverview(q: SerpQuery, t: SerpTenant): Promise<AiOverview | null>;
  readonly providers: { bulk: SerpProviderName; aio: SerpProviderName };
}

const DEFAULT_ESTIMATE: Record<SerpProviderName, { serp: number; autocomplete: number }> = {
  dataforseo: { serp: 0.002, autocomplete: 0.0006 },
  serpapi: { serp: 0.02, autocomplete: 0.01 },
};

export function createSerpClient(opts: SerpClientOptions): SerpClient {
  const bulk = opts.bulk;
  const aio = opts.aio ?? opts.bulk;
  const cache = opts.cache ?? memoryCache();
  const budget = opts.budget ?? memoryBudget({});
  const now = opts.now ?? (() => new Date());
  const estimate = { ...DEFAULT_ESTIMATE, ...opts.estimate };

  async function cachedCall<T extends { costUsd: number }>(
    provider: SerpProvider,
    method: "serp" | "autocomplete",
    q: SerpQuery,
    t: SerpTenant,
    call: () => Promise<T>,
  ): Promise<T & { cached: boolean }> {
    const day = dayOf(now());
    const key = cacheKey(provider.name, method, q, day);
    const hit = await cache.get<T>(key);
    if (hit) {
      await budget.record({ orgId: t.orgId, siteId: t.siteId ?? null, provider: provider.name, method, query: q.query, costUsd: 0, cached: true });
      return { ...hit, cached: true };
    }
    const hold = await budget.reserve(t.orgId, estimate[provider.name][method], { siteId: t.siteId ?? null, provider: provider.name, method, query: q.query });
    let result: T;
    try {
      result = await call();
    } catch (e) {
      // A failed call is not billed (or is retried and billed then); its hold goes back now. A failed
      // release must not hide the vendor's error (callers classify it); the sweeper gives the hold back.
      await budget.release(hold).catch((err) => console.warn(`[serp] release after a failed ${method} call: ${err instanceof Error ? err.message : String(err)}`));
      throw e;
    }
    // Settled and ledgered as soon as the vendor answers: the call is paid for, whatever happens next.
    await budget.record({ orgId: t.orgId, siteId: t.siteId ?? null, provider: provider.name, method, query: q.query, costUsd: result.costUsd, cached: false }, hold);
    // A failed cache write costs a repeat call later; failing this one would have the caller retry and pay again now.
    await cache
      .set(key, result, { provider: provider.name, method, query: q, day, costUsd: result.costUsd })
      .catch((err) => console.warn(`[serp] cache write after a paid ${method} call: ${err instanceof Error ? err.message : String(err)}`));
    return { ...result, cached: false };
  }

  return {
    providers: { bulk: bulk.name, aio: aio.name },
    autocomplete: (q, t) => cachedCall(bulk, "autocomplete", q, t, () => bulk.autocomplete(q)),
    serp: (q, t) => cachedCall(bulk, "serp", q, t, () => bulk.serp(q)),
    aioSerp: (q, t) => cachedCall(aio, "serp", q, t, () => aio.serp(q)),
    async paa(q, t) {
      return (await this.serp(q, t)).paa;
    },
    async aiOverview(q, t) {
      return (await this.aioSerp(q, t)).aiOverview;
    },
  };
}

/**
 * Production wiring from env. Bulk defaults to DataForSEO and AIO to SerpApi
 * (AEO_SERP_AIO_PROVIDER can pin AIO to either); when only one vendor is
 * configured it serves both roles, and the recorded `provider` on each
 * snapshot says which.
 */
export function serpClientFromEnv(env: NodeJS.ProcessEnv = process.env): SerpClient {
  const saKey = serpApiKey(env);
  const dfs = dataForSeoConfigured(env) ? dataForSeoProvider({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }) : null;
  const sa = saKey ? serpApiProvider({ apiKey: saKey }) : null;
  if (!dfs && !sa) throw new Error("no SERP provider configured (DATAFORSEO_LOGIN/PASSWORD or SERPAPI_API_KEY)");
  const aio = aioVendorPreference(env) === "dataforseo" ? dfs : (sa ?? dfs);
  return createSerpClient({
    bulk: (dfs ?? sa)!,
    aio: aio!,
    cache: postgresCache(),
    budget: postgresBudget(),
  });
}
