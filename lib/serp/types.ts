/**
 * One interface over the SERP vendors. DataForSEO is ~5× cheaper and suits
 * bulk (autocomplete expansion, PAA trees, rank tracking); SerpApi returns the
 * AI Overview `references` list natively, which is the fidelity the citation
 * product rests on. `provider` is recorded on every result — AIO detection
 * rates differ by vendor, and a silent swap would corrupt the time series.
 */

export type SerpProviderName = "dataforseo" | "serpapi";
export type SerpDevice = "desktop" | "mobile";

export interface SerpLocale {
  /** ISO 3166-1 alpha-2, lower case: "us", "gb". */
  country: string;
  /** ISO 639-1: "en". */
  language: string;
}

export interface SerpQuery {
  query: string;
  locale: SerpLocale;
  device: SerpDevice;
}

export interface AutocompleteResult {
  provider: SerpProviderName;
  query: string;
  suggestions: string[];
  fetchedAt: string;
  costUsd: number;
}

export interface PaaItem {
  question: string;
  answerSnippet?: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface OrganicResult {
  position: number;
  url: string;
  domain: string;
  title: string;
  snippet?: string;
}

export interface FeaturedSnippet {
  url: string;
  domain: string;
  title?: string;
  snippet?: string;
}

export interface AioReference {
  /** 1-based order in the overview's source list. */
  position: number;
  url: string;
  domain: string;
  title?: string;
}

export interface AiOverview {
  /** false = the provider looked and Google showed no overview. */
  triggered: boolean;
  text: string | null;
  references: AioReference[];
}

export interface SerpResult {
  provider: SerpProviderName;
  query: string;
  locale: SerpLocale;
  device: SerpDevice;
  fetchedAt: string;
  organic: OrganicResult[];
  paa: PaaItem[];
  featuredSnippet: FeaturedSnippet | null;
  /** null = this provider/endpoint cannot report on AI Overviews at all. */
  aiOverview: AiOverview | null;
  /** The vendor payload, stored verbatim so extraction can be re-run later. */
  raw: unknown;
  costUsd: number;
}

export interface SerpProvider {
  readonly name: SerpProviderName;
  autocomplete(q: SerpQuery): Promise<AutocompleteResult>;
  paa(q: SerpQuery): Promise<PaaItem[]>;
  serp(q: SerpQuery): Promise<SerpResult>;
  /** May cost a second request on some vendors. */
  aiOverview(q: SerpQuery): Promise<AiOverview | null>;
}

export class SerpProviderError extends Error {
  constructor(
    public readonly provider: SerpProviderName,
    message: string,
    public readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SerpProviderError";
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
