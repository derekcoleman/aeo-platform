import { normalizeDomain } from "@/lib/measure/source-roles";
import type { BudgetGuard } from "./budget";
import type { SerpCache } from "./cache";
import { paidCachedCall, type SerpTenant } from "./client";
import { dataForSeoPost, locationCode, type DataForSeoCredentials } from "./dataforseo";
import { vendorCostUsd } from "./env";
import type { SerpLocale } from "./types";

/**
 * DataForSEO Labs, on the same DataForSEO login as the SERP calls: which
 * keywords a domain ranks for in Google's organic results, with each
 * keyword's monthly volume, difficulty and main intent, from DataForSEO's
 * keyword database (POST /v3/dataforseo_labs/google/ranked_keywords/live).
 * The competitor organic gap (lib/strategy/competitor-gap.ts) asks it for
 * each named competitor and for the site itself.
 *
 * These are organic rankings, estimated from DataForSEO's own crawl, not a
 * live SERP and not an AI answer. One call returns up to 1,000 keywords for
 * about $0.11 (a task fee plus a fee per keyword), so results are cached for
 * the calendar month in measure.serp_cache and every call holds and settles
 * against the org's SERP budget (resource `serp`), like any SERP call.
 */

export const LABS_RANKED_KEYWORDS_PATH = "/dataforseo_labs/google/ranked_keywords/live";
/** The most keywords one call returns. */
export const RANKED_KEYWORDS_LIMIT = 1000;
/** Held against the budget before a call; DATAFORSEO_LABS_COST_USD overrides it. Settled at what the task says it cost. */
export const DATAFORSEO_LABS_COST_USD = 0.12;
export const DATAFORSEO_LABS_TIMEOUT_MS = 60_000;

/** The intents DataForSEO Labs reports (search_intent_info.main_intent); measure.questions.search_intent takes the same four. */
export const PROVIDER_INTENTS = ["informational", "navigational", "commercial", "transactional"] as const;
export type ProviderIntent = (typeof PROVIDER_INTENTS)[number];

export interface RankedKeywordsQuery {
  /** The domain, normalised (no scheme, www or path). */
  target: string;
  locale: SerpLocale;
  /** Keep keywords where the domain's best organic rank is at most this. */
  maxRank: number;
  /** At most RANKED_KEYWORDS_LIMIT. */
  limit?: number;
}

export interface RankedKeyword {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  searchIntent: ProviderIntent | null;
  /** The domain's organic rank (rank_group: organic results only). */
  rank: number;
  url: string | null;
}

export interface RankedKeywordsResult {
  provider: "dataforseo";
  target: string;
  locationCode: number;
  languageCode: string;
  /** The country asked for is not one DataForSEO knows: these are US rankings. */
  localeFallback: boolean;
  maxRank: number;
  /** Keywords the domain ranks for, as the vendor counts them; more than `keywords` holds when the list was cut. */
  total: number;
  /**
   * The list came back full at the limit with more behind it: a keyword
   * missing from it may still rank, below the lowest volume it holds.
   */
  truncated: boolean;
  /** Highest volume first. */
  keywords: RankedKeyword[];
  fetchedAt: string;
  costUsd: number;
}

// ── payload shapes (the subset we read) ─────────────────────────────────────
interface DfsLabsSerpItem {
  type?: string | null;
  rank_group?: number | null;
  rank_absolute?: number | null;
  url?: string | null;
}
interface DfsLabsItem {
  keyword_data?: {
    keyword?: string | null;
    keyword_info?: { search_volume?: number | null } | null;
    keyword_properties?: { keyword_difficulty?: number | null } | null;
    search_intent_info?: { main_intent?: string | null } | null;
  } | null;
  ranked_serp_element?: { serp_item?: DfsLabsSerpItem | null } | null;
}
export interface DfsRankedKeywordsResult {
  target?: string | null;
  total_count?: number | null;
  items_count?: number | null;
  items?: DfsLabsItem[] | null;
}

const wholeOrNull = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v)) : null;

/**
 * The request body: organic results only, ranks up to maxRank, highest
 * volume first. Keyword variants are kept (no ignore_synonyms): the gap is a
 * set difference between domains, and dropping a variant on one side only
 * would make a keyword look missing that is not.
 */
export function rankedKeywordsRequest(q: RankedKeywordsQuery): Record<string, unknown> {
  const loc = locationCode(q.locale.country);
  return {
    target: normalizeDomain(q.target),
    location_code: loc.code,
    language_code: q.locale.language.toLowerCase(),
    limit: Math.max(1, Math.min(RANKED_KEYWORDS_LIMIT, q.limit ?? RANKED_KEYWORDS_LIMIT)),
    item_types: ["organic"],
    filters: ["ranked_serp_element.serp_item.rank_group", "<=", q.maxRank],
    order_by: ["keyword_data.keyword_info.search_volume,desc"],
  };
}

/**
 * Keywords from one task's result: organic items at or above maxRank, one
 * per keyword (its best rank), highest volume first. Items without a keyword
 * or a rank are dropped; a volume, difficulty or intent the vendor did not
 * give is null, not zero.
 */
export function parseRankedKeywords(result: DfsRankedKeywordsResult, maxRank: number, limit = RANKED_KEYWORDS_LIMIT): { total: number; truncated: boolean; keywords: RankedKeyword[] } {
  const byKeyword = new Map<string, RankedKeyword>();
  for (const item of result.items ?? []) {
    const kd = item.keyword_data;
    const serp = item.ranked_serp_element?.serp_item;
    const keyword = kd?.keyword?.replace(/\s+/g, " ").trim();
    if (!keyword || !serp || (serp.type && serp.type !== "organic")) continue;
    const rank = wholeOrNull(serp.rank_group ?? serp.rank_absolute);
    if (rank === null || rank < 1 || rank > maxRank) continue;
    const intent = kd?.search_intent_info?.main_intent ?? null;
    const row: RankedKeyword = {
      keyword,
      searchVolume: wholeOrNull(kd?.keyword_info?.search_volume),
      keywordDifficulty: wholeOrNull(kd?.keyword_properties?.keyword_difficulty, 100),
      searchIntent: intent && (PROVIDER_INTENTS as readonly string[]).includes(intent) ? (intent as ProviderIntent) : null,
      rank,
      url: serp.url ?? null,
    };
    const key = keyword.toLowerCase();
    const seen = byKeyword.get(key);
    if (!seen || rank < seen.rank) byKeyword.set(key, row);
  }
  const keywords = [...byKeyword.values()].sort((a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1) || a.rank - b.rank || a.keyword.localeCompare(b.keyword));
  const returned = result.items?.length ?? 0;
  const total = Math.max(keywords.length, wholeOrNull(result.total_count) ?? 0);
  return { total, truncated: returned >= limit && total > returned, keywords };
}

export interface DataForSeoLabsConfig extends DataForSeoCredentials {
  /** What a call is held at before it is made; DATAFORSEO_LABS_COST_USD, else DATAFORSEO_LABS_COST_USD's default. */
  costUsd?: number;
  timeoutMs?: number;
}

export interface DataForSeoLabs {
  /** What one call is held at against the budget. */
  readonly estimateUsd: number;
  rankedKeywords(q: RankedKeywordsQuery): Promise<RankedKeywordsResult>;
}

export function dataForSeoLabs(cfg: DataForSeoLabsConfig = {}): DataForSeoLabs {
  const post = dataForSeoPost(cfg);
  const estimateUsd = cfg.costUsd ?? vendorCostUsd("DATAFORSEO_LABS_COST_USD", DATAFORSEO_LABS_COST_USD);
  const timeoutMs = cfg.timeoutMs ?? DATAFORSEO_LABS_TIMEOUT_MS;
  return {
    estimateUsd,
    async rankedKeywords(q) {
      const body = rankedKeywordsRequest(q);
      const { result, cost } = await post<DfsRankedKeywordsResult>(LABS_RANKED_KEYWORDS_PATH, body, timeoutMs);
      const { total, truncated, keywords } = parseRankedKeywords(result, q.maxRank, body.limit as number);
      return {
        provider: "dataforseo",
        target: q.target,
        locationCode: body.location_code as number,
        languageCode: body.language_code as string,
        localeFallback: locationCode(q.locale.country).fallback,
        maxRank: q.maxRank,
        total,
        truncated,
        keywords,
        fetchedAt: new Date().toISOString(),
        costUsd: cost || estimateUsd,
      };
    },
  };
}

/** The calendar month (UTC) a Labs result is cached for: "2026-10". */
export function monthOf(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * `dataforseo|labs.ranked_keywords|2840-en|r10|n1000|okta.com|2026-10`: the
 * market, the rank cut-off and the limit (each changes what comes back), the
 * domain and the month. Shared across tenants like a SERP key: a domain's
 * rankings do not depend on who asked.
 */
export function rankedKeywordsCacheKey(q: RankedKeywordsQuery, month: string): string {
  const body = rankedKeywordsRequest(q);
  return `dataforseo|labs.ranked_keywords|${body.location_code}-${body.language_code}|r${q.maxRank}|n${body.limit}|${body.target}|${month}`;
}

export interface RankedKeywordsDeps {
  labs: DataForSeoLabs;
  cache: SerpCache;
  budget: BudgetGuard;
  /** The month the result is cached under; fixed by the caller's run, so a retry after the month turns finds what it paid for. */
  month: string;
}

/**
 * A domain's ranked keywords for the month: from the cache when this month's
 * are there (ledgered free), else paid for through the org's SERP budget and
 * cached for everyone (lib/serp/client.ts paidCachedCall).
 */
export async function rankedKeywordsCached(q: RankedKeywordsQuery, tenant: SerpTenant, deps: RankedKeywordsDeps): Promise<RankedKeywordsResult & { cached: boolean }> {
  return paidCachedCall(
    { cache: deps.cache, budget: deps.budget },
    {
      key: rankedKeywordsCacheKey(q, deps.month),
      provider: "dataforseo",
      method: "labs.ranked_keywords",
      query: { query: q.target, locale: q.locale, device: "desktop" },
      day: `${deps.month}-01`,
      estimateUsd: deps.labs.estimateUsd,
      tenant,
      call: () => deps.labs.rankedKeywords(q),
    },
  );
}
