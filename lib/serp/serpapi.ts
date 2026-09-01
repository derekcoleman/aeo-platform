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
 * SerpApi. Materially more expensive than DataForSEO, but its AI Overview JSON
 * carries `text_blocks` and a `references` list of cited sources natively.
 * Used for AI Overview citation extraction on the tracked question set, where
 * fidelity is the product. Some responses hand back a `page_token` instead of
 * the overview; resolving it is a second billed search.
 */

const BASE = "https://serpapi.com/search.json";

export interface SerpApiConfig {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Per-search cost. Default reflects the ~$150 / 15k plan. */
  searchCostUsd?: number;
}

// ── payload shapes (the subset we read) ─────────────────────────────────────
interface SaOrganic { position?: number; link?: string; title?: string; snippet?: string }
interface SaRelatedQuestion { question?: string; snippet?: string; link?: string; title?: string }
interface SaAnswerBox { type?: string; link?: string; title?: string; snippet?: string; answer?: string }
interface SaReference { link?: string; title?: string; source?: string; index?: number }
interface SaTextBlock { type?: string; snippet?: string; list?: { snippet?: string }[] }
export interface SaAiOverview { text_blocks?: SaTextBlock[]; references?: SaReference[]; page_token?: string; error?: string }
export interface SaSearch {
  error?: string;
  organic_results?: SaOrganic[];
  related_questions?: SaRelatedQuestion[];
  answer_box?: SaAnswerBox;
  ai_overview?: SaAiOverview;
  suggestions?: { value?: string }[];
}

export function parseSerpApiAiOverview(aio: SaAiOverview | undefined): AiOverview | "pending" | null {
  if (!aio) return { triggered: false, text: null, references: [] };
  if (aio.page_token && !aio.text_blocks) return "pending";
  if (aio.error) return null;
  const parts: string[] = [];
  for (const b of aio.text_blocks ?? []) {
    if (b.snippet) parts.push(b.snippet);
    for (const li of b.list ?? []) if (li.snippet) parts.push(`- ${li.snippet}`);
  }
  const seen = new Set<string>();
  const references: AioReference[] = [];
  for (const r of aio.references ?? []) {
    if (!r.link || seen.has(r.link)) continue;
    seen.add(r.link);
    references.push({ position: references.length + 1, url: r.link, domain: domainOf(r.link), title: r.title ?? r.source });
  }
  return { triggered: parts.length > 0 || references.length > 0, text: parts.join("\n") || null, references };
}

export function parseSerpApiSerp(data: SaSearch): Pick<SerpResult, "organic" | "paa" | "featuredSnippet"> & { aiOverview: AiOverview | "pending" | null } {
  const organic: OrganicResult[] = (data.organic_results ?? [])
    .filter((o): o is SaOrganic & { link: string } => !!o.link)
    .map((o, i) => ({ position: o.position ?? i + 1, url: o.link, domain: domainOf(o.link), title: o.title ?? "", snippet: o.snippet }));
  const paa: PaaItem[] = (data.related_questions ?? [])
    .filter((q): q is SaRelatedQuestion & { question: string } => !!q.question)
    .map((q) => ({ question: q.question, answerSnippet: q.snippet, sourceUrl: q.link, sourceTitle: q.title }));
  const ab = data.answer_box;
  const featuredSnippet: FeaturedSnippet | null = ab?.link
    ? { url: ab.link, domain: domainOf(ab.link), title: ab.title, snippet: ab.snippet ?? ab.answer }
    : null;
  return { organic, paa, featuredSnippet, aiOverview: parseSerpApiAiOverview(data.ai_overview) };
}

export function serpApiProvider(cfg: SerpApiConfig = {}): SerpProvider {
  const apiKey = cfg.apiKey ?? process.env.SERPAPI_API_KEY;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const searchCost = cfg.searchCostUsd ?? Number(process.env.SERPAPI_SEARCH_COST_USD ?? 0.01);

  async function get(params: Record<string, string>): Promise<SaSearch> {
    if (!apiKey) throw new SerpProviderError("serpapi", "SERPAPI_API_KEY not set");
    const url = new URL(BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", apiKey);
    return withRetry(async () => {
      const res = await fetchImpl(url.toString());
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`serpapi ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
      }
      if (!res.ok) throw new SerpProviderError("serpapi", `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300), res.status);
      const data = (await res.json()) as SaSearch;
      if (data.error && !data.organic_results) throw new SerpProviderError("serpapi", data.error);
      return data;
    }, { maxRetries: 2 });
  }

  function common(q: SerpQuery): Record<string, string> {
    return { q: q.query, gl: q.locale.country.toLowerCase(), hl: q.locale.language.toLowerCase(), device: q.device };
  }

  async function resolvePending(token: string): Promise<AiOverview | null> {
    const data = await get({ engine: "google_ai_overview", page_token: token });
    const parsed = parseSerpApiAiOverview(data.ai_overview);
    return parsed === "pending" ? null : parsed;
  }

  const provider: SerpProvider = {
    name: "serpapi",
    async autocomplete(q) {
      const data = await get({ engine: "google_autocomplete", ...common(q) });
      const suggestions = (data.suggestions ?? []).map((s) => s.value?.trim() ?? "").filter((s, i, a) => s && a.indexOf(s) === i);
      return { provider: "serpapi", query: q.query, suggestions, fetchedAt: new Date().toISOString(), costUsd: searchCost };
    },
    async paa(q) {
      return (await provider.serp(q)).paa;
    },
    async serp(q) {
      const data = await get({ engine: "google", ...common(q), num: "20" });
      const parsed = parseSerpApiSerp(data);
      let cost = searchCost;
      let aiOverview: AiOverview | null;
      if (parsed.aiOverview === "pending") {
        aiOverview = await resolvePending(data.ai_overview!.page_token!);
        cost += searchCost;
      } else {
        aiOverview = parsed.aiOverview;
      }
      return {
        provider: "serpapi", query: q.query, locale: q.locale, device: q.device, fetchedAt: new Date().toISOString(),
        organic: parsed.organic, paa: parsed.paa, featuredSnippet: parsed.featuredSnippet, aiOverview, raw: data, costUsd: cost,
      };
    },
    async aiOverview(q) {
      return (await provider.serp(q)).aiOverview;
    },
  };
  return provider;
}
