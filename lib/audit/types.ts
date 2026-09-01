/**
 * Audit result shapes. Ported from gtm-agents `types/geo-audit.ts` with three
 * deliberate changes: `degraded` replaces zeroed defaults, platform readiness
 * is presentational (zero weight), and every scored dimension carries the
 * evidence that produced it so findings can be diffed run-over-run.
 */

export type CrawlerTier = 1 | 2 | 3;

export interface CrawlerCheckResult {
  name: string;
  userAgent: string;
  tier: CrawlerTier;
  /** Allowed at the site root. */
  allowed: boolean;
  /** Per-path verdicts for the paths the audit cares about (root + content prefix + sampled pages). */
  paths: { path: string; allowed: boolean; rule: string | null }[];
  rule: string | null;
}

export interface CrawlerAccessResult {
  robotsTxtFound: boolean;
  robotsTxtUrl: string;
  robotsTxtStatus: number | null;
  crawlers: CrawlerCheckResult[];
  tier1Score: number;
  tier2Score: number;
  blanketBlockDetected: boolean;
  /** Paths where at least one tier-1 crawler is blocked while `*` is allowed. */
  pathBlocks: { path: string; crawlers: string[] }[];
  aiSpecificFilesPresent: boolean;
  totalScore: number;
}

export type SchemaFormat = "json-ld" | "microdata" | "rdfa" | "none" | "mixed";

export interface SchemaItem {
  type: string;
  format: "json-ld" | "microdata" | "rdfa";
  properties: string[];
  hasSameAs: boolean;
  sameAsUrls?: string[];
  sourceUrl: string;
}

export interface SchemaScores {
  organizationWithSameAs: number; // /20
  articleWithAuthor: number; // /15
  personSchema: number; // /15
  sameAsCompleteness: number; // /15
  speakableProperty: number; // /10
  breadcrumbList: number; // /5
  websiteSearchAction: number; // /5
  noDeprecated: number; // /5
  jsonLdFormat: number; // /5
  validation: number; // /5
}

export interface SchemaAnalysisResult {
  format: SchemaFormat;
  schemasFound: SchemaItem[];
  malformedBlocks: number;
  scores: SchemaScores;
  totalScore: number;
  issues: string[];
}

export interface PassageCitabilityScore {
  passage: string;
  answerBlockQuality: number; // /30
  selfContainment: number; // /25
  structuralReadability: number; // /20
  statisticalDensity: number; // /15
  uniqueness: number; // /10
  totalScore: number;
}

export interface CitabilityDimensions {
  answerBlockQuality: number;
  selfContainment: number;
  structuralReadability: number;
  statisticalDensity: number;
  uniqueness: number;
}

export interface PageCitabilityResult {
  url: string;
  title: string;
  topPassages: PassageCitabilityScore[];
  averageScore: number;
  /** Set when the page could not be scored; excluded from averages. */
  error?: string;
}

export interface CitabilityResult {
  pages: PageCitabilityResult[];
  averageScore: number;
  dimensions: CitabilityDimensions;
}

export type EeatDimension = "experience" | "expertise" | "authoritativeness" | "trustworthiness";

export interface EeatSignal {
  dimension: EeatDimension;
  signal: string;
  present: boolean;
  impact: "high" | "medium" | "low";
}

export interface EeatResult {
  experience: number; // /25
  expertise: number; // /25
  authoritativeness: number; // /25
  trustworthiness: number; // /25
  totalScore: number;
  signals: EeatSignal[];
}

export type SsrFramework = "next.js" | "nuxt" | "gatsby" | "astro" | "remix" | "sveltekit" | "spa" | "ssr" | "unknown";

export interface TechnicalResult {
  ssrDetected: boolean;
  framework: SsrFramework;
  metaTags: { present: string[]; missing: string[]; details: Record<string, string> };
  securityHeaders: { present: string[]; missing: string[] };
  mobileOptimized: boolean;
  urlStructure: "clean" | "parameterized" | "mixed";
  coreWebVitalsIndicators: {
    hasLargeHeroImage: boolean;
    hasRenderBlockingResources: boolean;
    hasUnsizedImages: boolean;
    estimatedLcpRisk: "low" | "medium" | "high";
  };
  httpStatus: number;
  httpsEnabled: boolean;
  noindex: boolean;
  totalScore: number;
}

export interface PlatformScore {
  score: number;
  strengths: string[];
  weaknesses: string[];
}

export interface PlatformReadinessResult {
  platforms: {
    googleAIOverviews: PlatformScore;
    chatgptWebSearch: PlatformScore;
    perplexityAI: PlatformScore;
    googleGemini: PlatformScore;
    bingCopilot: PlatformScore;
  };
  averageScore: number;
}

export interface LlmsTxtResult {
  found: boolean;
  url: string;
  valid: boolean;
  sections: string[];
  issues: string[];
  generatedContent?: string;
}

export type RecommendationCategory =
  | "crawler_access"
  | "schema"
  | "citability"
  | "eeat"
  | "technical"
  | "platform"
  | "llms_txt"
  | "indexation";

export type Priority = "critical" | "high" | "medium" | "low";

export interface Recommendation {
  /** Stable key from the shared rule registry; the unit of diffing. */
  ruleKey: string;
  category: RecommendationCategory;
  priority: Priority;
  title: string;
  description: string;
  impact: string;
  evidence?: Record<string, unknown>;
}

/** Weighted dimensions. Platform readiness is intentionally absent — see score.ts. */
export interface DimensionScores {
  crawlerAccess: number;
  schema: number;
  citability: number;
  eeat: number;
  technical: number;
  llmsTxt: number;
}

export interface AuditPage {
  url: string;
  title: string;
  status: number;
  html: string;
  markdown: string;
  fetchedAt: string;
}

export interface AuditResult {
  targetUrl: string;
  finalUrl: string;
  domain: string;
  geoScore: number;
  dimensions: DimensionScores;
  crawlerAccess: CrawlerAccessResult | null;
  schema: SchemaAnalysisResult | null;
  citability: CitabilityResult | null;
  eeat: EeatResult | null;
  technical: TechnicalResult | null;
  platformReadiness: PlatformReadinessResult | null;
  llmsTxt: LlmsTxtResult | null;
  recommendations: Recommendation[];
  /** Modules that failed. Never zero-filled: a null module is not a 0 score. */
  degraded: { module: string; reason: string }[];
  pagesAnalyzed: number;
  pageUrls: string[];
  durationMs: number;
  llmCalls: number;
  ruleRegistryVersion: string;
}

export type ScoreRating = "excellent" | "good" | "fair" | "poor" | "critical";

/** One band table. gtm-agents had two that disagreed (90/75/60/40 vs 80/60/40). */
export const SCORE_BANDS: { min: number; rating: ScoreRating; color: string }[] = [
  { min: 90, rating: "excellent", color: "emerald" },
  { min: 75, rating: "good", color: "green" },
  { min: 60, rating: "fair", color: "yellow" },
  { min: 40, rating: "poor", color: "orange" },
  { min: 0, rating: "critical", color: "red" },
];

export function scoreRating(score: number): ScoreRating {
  return SCORE_BANDS.find((b) => score >= b.min)!.rating;
}

export function scoreColor(score: number): string {
  return SCORE_BANDS.find((b) => score >= b.min)!.color;
}
