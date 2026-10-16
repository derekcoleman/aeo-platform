import { withRetry, RetryableError, parseRetryAfter } from "@/lib/fetch/retry";
import { vendorCostUsd } from "./env";
import {
  domainOf,
  retryUnlessTimedOut,
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

/** ISO 3166-1 numeric codes by alpha-2. A Google country location code is 2000 + this number. */
export const ISO_NUMERIC: Record<string, number> = {
  ad: 20, ae: 784, af: 4, ag: 28, ai: 660, al: 8, am: 51, ao: 24, aq: 10, ar: 32, as: 16, at: 40, au: 36, aw: 533, ax: 248, az: 31,
  ba: 70, bb: 52, bd: 50, be: 56, bf: 854, bg: 100, bh: 48, bi: 108, bj: 204, bl: 652, bm: 60, bn: 96, bo: 68, bq: 535, br: 76, bs: 44, bt: 64, bv: 74, bw: 72, by: 112, bz: 84,
  ca: 124, cc: 166, cd: 180, cf: 140, cg: 178, ch: 756, ci: 384, ck: 184, cl: 152, cm: 120, cn: 156, co: 170, cr: 188, cu: 192, cv: 132, cw: 531, cx: 162, cy: 196, cz: 203,
  de: 276, dj: 262, dk: 208, dm: 212, do: 214, dz: 12,
  ec: 218, ee: 233, eg: 818, eh: 732, er: 232, es: 724, et: 231,
  fi: 246, fj: 242, fk: 238, fm: 583, fo: 234, fr: 250,
  ga: 266, gb: 826, gd: 308, ge: 268, gf: 254, gg: 831, gh: 288, gi: 292, gl: 304, gm: 270, gn: 324, gp: 312, gq: 226, gr: 300, gs: 239, gt: 320, gu: 316, gw: 624, gy: 328,
  hk: 344, hm: 334, hn: 340, hr: 191, ht: 332, hu: 348,
  id: 360, ie: 372, il: 376, im: 833, in: 356, io: 86, iq: 368, ir: 364, is: 352, it: 380,
  je: 832, jm: 388, jo: 400, jp: 392,
  ke: 404, kg: 417, kh: 116, ki: 296, km: 174, kn: 659, kp: 408, kr: 410, kw: 414, ky: 136, kz: 398,
  la: 418, lb: 422, lc: 662, li: 438, lk: 144, lr: 430, ls: 426, lt: 440, lu: 442, lv: 428, ly: 434,
  ma: 504, mc: 492, md: 498, me: 499, mf: 663, mg: 450, mh: 584, mk: 807, ml: 466, mm: 104, mn: 496, mo: 446, mp: 580, mq: 474, mr: 478, ms: 500, mt: 470, mu: 480, mv: 462, mw: 454, mx: 484, my: 458, mz: 508,
  na: 516, nc: 540, ne: 562, nf: 574, ng: 566, ni: 558, nl: 528, no: 578, np: 524, nr: 520, nu: 570, nz: 554,
  om: 512,
  pa: 591, pe: 604, pf: 258, pg: 598, ph: 608, pk: 586, pl: 616, pm: 666, pn: 612, pr: 630, ps: 275, pt: 620, pw: 585, py: 600,
  qa: 634,
  re: 638, ro: 642, rs: 688, ru: 643, rw: 646,
  sa: 682, sb: 90, sc: 690, sd: 729, se: 752, sg: 702, sh: 654, si: 705, sj: 744, sk: 703, sl: 694, sm: 674, sn: 686, so: 706, sr: 740, ss: 728, st: 678, sv: 222, sx: 534, sy: 760, sz: 748,
  tc: 796, td: 148, tf: 260, tg: 768, th: 764, tj: 762, tk: 772, tl: 626, tm: 795, tn: 788, to: 776, tr: 792, tt: 780, tv: 798, tw: 158, tz: 834,
  ua: 804, ug: 800, um: 581, us: 840, uy: 858, uz: 860,
  va: 336, vc: 670, ve: 862, vg: 92, vi: 850, vn: 704, vu: 548,
  wf: 876, ws: 882,
  ye: 887, yt: 175,
  za: 710, zm: 894, zw: 716,
};

/** Alpha-2 spellings people use that ISO does not. */
const COUNTRY_ALIASES: Record<string, string> = { uk: "gb", el: "gr" };

export const DEFAULT_LOCATION_CODE = 2840;

/**
 * The Google location code for a country (US 2840, JP 2392, BR 2076). An
 * unknown country falls back to the United States instead of failing the
 * call; `fallback` says so, and the snapshot's raw payload records it.
 */
export function locationCode(country: string): { code: number; fallback: boolean } {
  const c = country.trim().toLowerCase();
  const n = ISO_NUMERIC[COUNTRY_ALIASES[c] ?? c];
  return n === undefined ? { code: DEFAULT_LOCATION_CODE, fallback: true } : { code: 2000 + n, fallback: false };
}

/** Per-call deadlines: a live SERP with the AI Overview loaded can take a minute; autocomplete is quick. */
export const DATAFORSEO_TIMEOUTS_MS = { serp: 90_000, autocomplete: 30_000 };

export interface DataForSeoConfig {
  login?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  /** Fallback cost per call when the response carries none. */
  serpCostUsd?: number;
  autocompleteCostUsd?: number;
  timeoutsMs?: Partial<typeof DATAFORSEO_TIMEOUTS_MS>;
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
  const serpCost = cfg.serpCostUsd ?? vendorCostUsd("DATAFORSEO_SERP_COST_USD", 0.002);
  const acCost = cfg.autocompleteCostUsd ?? vendorCostUsd("DATAFORSEO_AUTOCOMPLETE_COST_USD", 0.0006);
  const timeouts = { ...DATAFORSEO_TIMEOUTS_MS, ...cfg.timeoutsMs };

  async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<{ result: T; cost: number; raw: unknown }> {
    if (!login || !password) throw new SerpProviderError("dataforseo", "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set");
    const auth = Buffer.from(`${login}:${password}`).toString("base64");
    return withRetry(async () => {
      const res = await fetchImpl(`${BASE}${path}`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
        body: JSON.stringify([body]),
        signal: AbortSignal.timeout(timeoutMs),
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
    }, { maxRetries: 2, shouldRetry: retryUnlessTimedOut });
  }

  function common(q: SerpQuery) {
    const loc = locationCode(q.locale.country);
    const params = { keyword: q.query, location_code: loc.code, language_code: q.locale.language.toLowerCase(), device: q.device };
    return { params, fallback: loc.fallback ? { requested: q.locale.country.toLowerCase(), locationCode: loc.code } : null };
  }

  const provider: SerpProvider = {
    name: "dataforseo",
    async autocomplete(q) {
      const { result, cost } = await post<DfsAutocompleteResult>("/serp/google/autocomplete/live/advanced", {
        ...common(q).params, client: "gws-wiz-serp",
      }, timeouts.autocomplete);
      return { provider: "dataforseo", query: q.query, suggestions: parseDataForSeoAutocomplete(result), fetchedAt: new Date().toISOString(), costUsd: cost || acCost };
    },
    async paa(q) {
      return (await provider.serp(q)).paa;
    },
    async serp(q) {
      const { params, fallback } = common(q);
      const { result, cost, raw } = await post<DfsSerpResult>("/serp/google/organic/live/advanced", {
        ...params, depth: 20, load_async_ai_overview: true, people_also_ask_click_depth: 2,
      }, timeouts.serp);
      return {
        provider: "dataforseo", query: q.query, locale: q.locale, device: q.device,
        fetchedAt: new Date().toISOString(), ...parseDataForSeoSerp(result),
        raw: fallback ? { ...(raw as object), localeFallback: fallback } : raw,
        costUsd: cost || serpCost,
      };
    },
    async aiOverview(q) {
      return (await provider.serp(q)).aiOverview;
    },
  };
  return provider;
}
