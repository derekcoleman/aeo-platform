import { withRetry, RetryableError, parseRetryAfter } from "@/lib/fetch/retry";
import {
  domainOf,
  SerpProviderError,
  type AiOverview,
  type AioReference,
  type FeaturedSnippet,
  type OrganicResult,
  type PaaItem,
  type SerpProvider,
  type SerpQuery,
  type SerpResult,
} from "./types";

/**
 * DataForSEO live endpoints. Cheap at volume; used for autocomplete expansion,
 * PAA trees and rank tracking. The AI Overview surface is parsed best-effort —
 * the plan flags vendor detection rates as unverified, so the golden-query
 * comparison in tests/fixtures is what decides whether `aiOverview` from this
 * provider is trusted for the citation time series.
 */

const BASE = "https://api.dataforseo.com/v3";

/** Google location codes for the countries we serve. Extend as tenants need. */
export const DATAFORSEO_LOCATIONS: Record<string, number> = {
  us: 2840, gb: 2826, ca: 2124, au: 2036, de: 2276, fr: 2250, nl: 2528, ie: 2372, in: 2356, sg: 2702,
};

export interface DataForSeoConfig {
  login?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  /** Fallback cost per call when the response carries none. */
  serpCostUsd?: number;
  autocompleteCostUsd?: number;
}

// ── payload shapes (the subset we read) ─────────────────────────────────────
interface DfsTask<T> { status_code: number; status_message: string; cost?: number; result?: T[] | null }
interface DfsEnvelope<T> { status_code: number; status_message: string; tasks?: DfsTask<T>[] }
interface DfsLink { url?: string; title?: string; domain?: string; description?: string }
interface DfsItem {
  type: string;
  rank_absolute?: number;
  url?: string;
  domain?: string;
  title?: string;
  description?: string;
  items?: DfsItem[];
  expanded_element?: DfsItem[];
  featured_title?: string;
  references?: DfsLink[];
  text?: string;
  suggestion?: string;
}
interface DfsSerpResult { keyword: string; items?: DfsItem[] | null }
interface DfsAutocompleteResult { keyword: string; items?: { suggestion?: string }[] | null }

export function parseDataForSeoSerp(result: DfsSerpResult): Pick<SerpResult, "organic" | "paa" | "featuredSnippet" | "aiOverview"> {
  const organic: OrganicResult[] = [];
  const paa: PaaItem[] = [];
  let featuredSnippet: FeaturedSnippet | null = null;
  let aiOverview: AiOverview | null = null;
  let position = 0;

  for (const item of result.items ?? []) {
    switch (item.type) {
      case "organic":
        if (!item.url) break;
        position += 1;
        organic.push({ position, url: item.url, domain: item.domain ?? domainOf(item.url), title: item.title ?? "", snippet: item.description });
        break;
      case "featured_snippet":
        if (item.url) featuredSnippet = { url: item.url, domain: item.domain ?? domainOf(item.url), title: item.title, snippet: item.description };
        break;
      case "people_also_ask":
        for (const q of item.items ?? []) {
          if (!q.title) continue;
          const ans = q.expanded_element?.[0];
          paa.push({ question: q.title, answerSnippet: ans?.description, sourceUrl: ans?.url, sourceTitle: ans?.title });
        }
        break;
      case "ai_overview": {
        const refs = collectReferences(item);
        const text = (item.items ?? []).map((i) => i.text ?? "").filter(Boolean).join("\n\n") || item.text || null;
        aiOverview = { triggered: true, text, references: refs };
        break;
      }
      default:
        break;
    }
  }
  // The endpoint was asked to load AIO; no item means Google showed none.
  if (!aiOverview) aiOverview = { triggered: false, text: null, references: [] };
  return { organic, paa, featuredSnippet, aiOverview };
}

function collectReferences(item: DfsItem): AioReference[] {
  const seen = new Set<string>();
  const out: AioReference[] = [];
  const push = (l: DfsLink) => {
    if (!l.url || seen.has(l.url)) return;
    seen.add(l.url);
    out.push({ position: out.length + 1, url: l.url, domain: l.domain ?? domainOf(l.url), title: l.title });
  };
  for (const r of item.references ?? []) push(r);
  for (const sub of item.items ?? []) for (const r of sub.references ?? []) push(r);
  return out;
}

export function parseDataForSeoAutocomplete(result: DfsAutocompleteResult): string[] {
  const out: string[] = [];
  for (const it of result.items ?? []) {
    const s = it.suggestion?.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function dataForSeoProvider(cfg: DataForSeoConfig = {}): SerpProvider {
  const login = cfg.login ?? process.env.DATAFORSEO_LOGIN;
  const password = cfg.password ?? process.env.DATAFORSEO_PASSWORD;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const serpCost = cfg.serpCostUsd ?? Number(process.env.DATAFORSEO_SERP_COST_USD ?? 0.002);
  const acCost = cfg.autocompleteCostUsd ?? Number(process.env.DATAFORSEO_AUTOCOMPLETE_COST_USD ?? 0.0006);

  async function post<T>(path: string, body: unknown): Promise<{ result: T; cost: number; raw: unknown }> {
    if (!login || !password) throw new SerpProviderError("dataforseo", "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set");
    const auth = Buffer.from(`${login}:${password}`).toString("base64");
    return withRetry(async () => {
      const res = await fetchImpl(`${BASE}${path}`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
        body: JSON.stringify([body]),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`dataforseo ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
      }
      if (!res.ok) throw new SerpProviderError("dataforseo", `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300), res.status);
      const env = (await res.json()) as DfsEnvelope<T>;
      const task = env.tasks?.[0];
      if (!task || task.status_code >= 40000 || !task.result?.[0]) {
        throw new SerpProviderError("dataforseo", task?.status_message ?? env.status_message ?? "empty task", task?.status_code);
      }
      return { result: task.result[0], cost: task.cost ?? 0, raw: env };
    }, { maxRetries: 2 });
  }

  function common(q: SerpQuery) {
    const location_code = DATAFORSEO_LOCATIONS[q.locale.country.toLowerCase()];
    if (!location_code) throw new SerpProviderError("dataforseo", `no location code for country "${q.locale.country}"`);
    return { keyword: q.query, location_code, language_code: q.locale.language.toLowerCase(), device: q.device };
  }

  const provider: SerpProvider = {
    name: "dataforseo",
    async autocomplete(q) {
      const { result, cost } = await post<DfsAutocompleteResult>("/serp/google/autocomplete/live/advanced", {
        ...common(q), client: "gws-wiz-serp",
      });
      return { provider: "dataforseo", query: q.query, suggestions: parseDataForSeoAutocomplete(result), fetchedAt: new Date().toISOString(), costUsd: cost || acCost };
    },
    async paa(q) {
      return (await provider.serp(q)).paa;
    },
    async serp(q) {
      const { result, cost, raw } = await post<DfsSerpResult>("/serp/google/organic/live/advanced", {
        ...common(q), depth: 20, load_async_ai_overview: true, people_also_ask_click_depth: 2,
      });
      return {
        provider: "dataforseo", query: q.query, locale: q.locale, device: q.device,
        fetchedAt: new Date().toISOString(), ...parseDataForSeoSerp(result), raw, costUsd: cost || serpCost,
      };
    },
    async aiOverview(q) {
      return (await provider.serp(q)).aiOverview;
    },
  };
  return provider;
}
