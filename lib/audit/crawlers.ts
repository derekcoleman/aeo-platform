import type { CrawlerAccessResult, CrawlerCheckResult, CrawlerTier } from "./types";
import { evaluatePath, hasBlanketBlock, parseRobotsTxt, type ParsedRobots } from "./robots";

/**
 * The AI crawlers that matter, tiered by commercial impact.
 *
 * `purpose` mirrors ops.bots: `train` takes months to matter, `search_index`
 * weeks, and `live_fetch` is a model fetching a URL mid-answer for a real
 * user — the signal the whole dashboard is built around.
 */
export interface AiCrawler {
  name: string;
  userAgent: string;
  tier: CrawlerTier;
  operator: string;
  purpose: "train" | "search_index" | "live_fetch";
}

export const AI_CRAWLERS: AiCrawler[] = [
  { name: "GPTBot", userAgent: "GPTBot", tier: 1, operator: "OpenAI", purpose: "train" },
  { name: "OAI-SearchBot", userAgent: "OAI-SearchBot", tier: 1, operator: "OpenAI", purpose: "search_index" },
  { name: "ChatGPT-User", userAgent: "ChatGPT-User", tier: 1, operator: "OpenAI", purpose: "live_fetch" },
  { name: "ClaudeBot", userAgent: "ClaudeBot", tier: 1, operator: "Anthropic", purpose: "train" },
  { name: "Claude-User", userAgent: "Claude-User", tier: 1, operator: "Anthropic", purpose: "live_fetch" },
  { name: "Claude-SearchBot", userAgent: "Claude-SearchBot", tier: 1, operator: "Anthropic", purpose: "search_index" },
  { name: "PerplexityBot", userAgent: "PerplexityBot", tier: 1, operator: "Perplexity", purpose: "search_index" },
  { name: "Perplexity-User", userAgent: "Perplexity-User", tier: 1, operator: "Perplexity", purpose: "live_fetch" },
  { name: "Google-Extended", userAgent: "Google-Extended", tier: 2, operator: "Google", purpose: "train" },
  { name: "GoogleOther", userAgent: "GoogleOther", tier: 2, operator: "Google", purpose: "train" },
  { name: "Applebot-Extended", userAgent: "Applebot-Extended", tier: 2, operator: "Apple", purpose: "train" },
  { name: "Amazonbot", userAgent: "Amazonbot", tier: 2, operator: "Amazon", purpose: "search_index" },
  { name: "Meta-ExternalAgent", userAgent: "meta-externalagent", tier: 2, operator: "Meta", purpose: "train" },
  { name: "Bingbot", userAgent: "bingbot", tier: 2, operator: "Microsoft", purpose: "search_index" },
  { name: "CCBot", userAgent: "CCBot", tier: 3, operator: "Common Crawl", purpose: "train" },
  { name: "anthropic-ai", userAgent: "anthropic-ai", tier: 3, operator: "Anthropic (legacy)", purpose: "train" },
  { name: "Bytespider", userAgent: "Bytespider", tier: 3, operator: "ByteDance", purpose: "train" },
  { name: "cohere-ai", userAgent: "cohere-ai", tier: 3, operator: "Cohere", purpose: "train" },
];

export interface CrawlerAccessInput {
  robotsTxtUrl: string;
  robotsTxtStatus: number | null;
  robotsTxtBody: string | null;
  /** Paths to evaluate beyond `/`. The content prefix and sampled pages. */
  paths: string[];
  aiSpecificFilesPresent: boolean;
}

/** Pure: everything network-related has already happened. */
export function evaluateCrawlerAccess(input: CrawlerAccessInput): CrawlerAccessResult {
  const found = input.robotsTxtStatus === 200 && input.robotsTxtBody !== null;
  const robots: ParsedRobots = found ? parseRobotsTxt(input.robotsTxtBody!) : { groups: [], sitemaps: [] };
  const paths = Array.from(new Set(["/", ...input.paths.filter((p) => p.startsWith("/"))]));

  const crawlers: CrawlerCheckResult[] = AI_CRAWLERS.map((c) => {
    const verdicts = paths.map((path) => {
      const v = evaluatePath(robots, c.userAgent, path);
      return { path, allowed: v.allowed, rule: v.rule?.line ?? null };
    });
    const root = verdicts[0]!;
    return { name: c.name, userAgent: c.userAgent, tier: c.tier, allowed: root.allowed, paths: verdicts, rule: root.rule };
  });

  // A crawler counts as "allowed" only if it can reach every path we care about.
  const fullyAllowed = (c: CrawlerCheckResult) => c.paths.every((p) => p.allowed);
  const tier1 = crawlers.filter((c) => c.tier === 1);
  const tier2 = crawlers.filter((c) => c.tier === 2);
  const tier1Score = Math.round((tier1.filter(fullyAllowed).length / tier1.length) * 100);
  const tier2Score = Math.round((tier2.filter(fullyAllowed).length / tier2.length) * 100);

  const pathBlocks: CrawlerAccessResult["pathBlocks"] = [];
  for (const path of paths) {
    const blocked = tier1.filter((c) => c.paths.find((p) => p.path === path)?.allowed === false).map((c) => c.name);
    if (blocked.length > 0 && blocked.length < tier1.length) pathBlocks.push({ path, crawlers: blocked });
  }

  const blanket = hasBlanketBlock(robots);
  const totalScore = Math.round(
    tier1Score * 0.5 + tier2Score * 0.25 + (blanket ? 0 : 15) + (input.aiSpecificFilesPresent ? 10 : 0),
  );

  return {
    robotsTxtFound: found,
    robotsTxtUrl: input.robotsTxtUrl,
    robotsTxtStatus: input.robotsTxtStatus,
    crawlers,
    tier1Score,
    tier2Score,
    blanketBlockDetected: blanket,
    pathBlocks,
    aiSpecificFilesPresent: input.aiSpecificFilesPresent,
    totalScore: Math.max(0, Math.min(100, totalScore)),
  };
}
