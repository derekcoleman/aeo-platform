import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { parseScoredJson } from "@/lib/ai/scored-json";
import type { PlatformReadinessResult, PlatformScore } from "./types";

/**
 * Per-platform readiness. Presentational only: it is a model's re-reading of
 * the other dimensions, so it carries zero weight in the composite (see
 * score.ts). It stays because "how do I look to Perplexity specifically" is a
 * question customers ask.
 */

const PlatformSchema = z.object({
  score: z.number().min(0).max(100),
  strengths: z.array(z.string()).max(4).default([]),
  weaknesses: z.array(z.string()).max(4).default([]),
});

const Schema = z.object({
  googleAIOverviews: PlatformSchema,
  chatgptWebSearch: PlatformSchema,
  perplexityAI: PlatformSchema,
  googleGemini: PlatformSchema,
  bingCopilot: PlatformSchema,
});

export interface PlatformInput {
  crawlerSummary: string;
  schemaSummary: string;
  citabilitySummary: string;
  eeatSummary: string;
  technicalSummary: string;
  llmsTxtSummary: string;
}

export async function assessPlatformReadiness(model: TextModel, input: PlatformInput): Promise<PlatformReadinessResult> {
  const prompt = `Given these audit findings for a website, estimate readiness (0-100) for each AI answer platform, with up to 3 strengths and 3 weaknesses each. Weigh what each platform actually depends on: Google AI Overviews and Gemini lean on Google's index, schema and E-E-A-T; ChatGPT search depends on OAI-SearchBot/GPTBot access and clean SSR; Perplexity on PerplexityBot access and citable passages; Bing Copilot on bingbot access, IndexNow and schema.

Crawler access: ${input.crawlerSummary}
Structured data: ${input.schemaSummary}
Citability: ${input.citabilitySummary}
E-E-A-T: ${input.eeatSummary}
Technical: ${input.technicalSummary}
llms.txt: ${input.llmsTxtSummary}

Reply with JSON only:
{"googleAIOverviews":{"score":n,"strengths":[],"weaknesses":[]},"chatgptWebSearch":{...},"perplexityAI":{...},"googleGemini":{...},"bingCopilot":{...}}`;

  const { text } = await model.complete(prompt, { json: true, maxTokens: 1200 });
  const platforms = parseScoredJson(text, Schema);
  const round = (p: PlatformScore): PlatformScore => ({ ...p, score: Math.round(p.score) });
  const rounded = {
    googleAIOverviews: round(platforms.googleAIOverviews),
    chatgptWebSearch: round(platforms.chatgptWebSearch),
    perplexityAI: round(platforms.perplexityAI),
    googleGemini: round(platforms.googleGemini),
    bingCopilot: round(platforms.bingCopilot),
  };
  const averageScore = Math.round(Object.values(rounded).reduce((n, p) => n + p.score, 0) / 5);
  return { platforms: rounded, averageScore };
}
