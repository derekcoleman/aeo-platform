import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { parseScoredJson } from "@/lib/ai/scored-json";
import { mapConcurrent } from "@/lib/fetch/fetch";
import type { CitabilityResult, PageCitabilityResult, PassageCitabilityScore } from "./types";

/**
 * Passage citability: for each page, the model picks the three passages an
 * answer engine would most plausibly lift and scores them on five dimensions.
 * Pages run in parallel (the old sequential loop was protecting a rate limiter
 * that doesn't govern model calls).
 */

const PassageSchema = z.object({
  passage: z.string().min(1).max(1200),
  answerBlockQuality: z.number().min(0).max(30),
  selfContainment: z.number().min(0).max(25),
  structuralReadability: z.number().min(0).max(20),
  statisticalDensity: z.number().min(0).max(15),
  uniqueness: z.number().min(0).max(10),
});

const PageSchema = z.object({ passages: z.array(PassageSchema).min(1).max(5) });

export interface CitabilityPageInput {
  url: string;
  title: string;
  markdown: string;
}

export function citabilityPrompt(page: CitabilityPageInput, maxChars: number): string {
  return `You are evaluating how citable a web page's content is for AI answer engines (Google AI Overviews, ChatGPT search, Perplexity). These engines lift short, self-contained passages that directly answer a question.

Page: ${page.title || page.url}
URL: ${page.url}

Content (markdown, truncated):
"""
${page.markdown.slice(0, maxChars)}
"""

Select the 3 passages (40-120 words each, quoted verbatim) most likely to be cited, and score each:
- answerBlockQuality (0-30): does it directly answer a specific question in its first sentence?
- selfContainment (0-25): is it understandable with zero surrounding context?
- structuralReadability (0-20): clear sentences, lists/tables where appropriate, no fluff
- statisticalDensity (0-15): specific numbers, dates, named entities, attributed facts
- uniqueness (0-10): information a competitor could not have written

If the page has no substantive content, return one passage with the best available text and low scores. Reply with JSON only:
{"passages":[{"passage":"...","answerBlockQuality":n,"selfContainment":n,"structuralReadability":n,"statisticalDensity":n,"uniqueness":n}]}`;
}

export async function scorePageCitability(model: TextModel, page: CitabilityPageInput, maxChars: number): Promise<PageCitabilityResult> {
  if (page.markdown.trim().length < 200) {
    return { url: page.url, title: page.title, topPassages: [], averageScore: 0, error: "insufficient content" };
  }
  try {
    const { text } = await model.complete(citabilityPrompt(page, maxChars), { json: true, maxTokens: 1500 });
    const parsed = parseScoredJson(text, PageSchema);
    const topPassages: PassageCitabilityScore[] = parsed.passages.slice(0, 3).map((p) => ({
      ...p,
      totalScore: Math.round(p.answerBlockQuality + p.selfContainment + p.structuralReadability + p.statisticalDensity + p.uniqueness),
    }));
    const averageScore = Math.round(topPassages.reduce((n, p) => n + p.totalScore, 0) / Math.max(1, topPassages.length));
    return { url: page.url, title: page.title, topPassages, averageScore };
  } catch (e) {
    return { url: page.url, title: page.title, topPassages: [], averageScore: 0, error: (e as Error).message };
  }
}

export function aggregateCitability(pages: PageCitabilityResult[]): CitabilityResult {
  const scored = pages.filter((p) => !p.error && p.topPassages.length > 0);
  const passages = scored.flatMap((p) => p.topPassages);
  const avg = (k: keyof Omit<PassageCitabilityScore, "passage" | "totalScore">) =>
    passages.length === 0 ? 0 : Math.round(passages.reduce((n, p) => n + p[k], 0) / passages.length);
  return {
    pages,
    averageScore: scored.length === 0 ? 0 : Math.round(scored.reduce((n, p) => n + p.averageScore, 0) / scored.length),
    dimensions: {
      answerBlockQuality: avg("answerBlockQuality"),
      selfContainment: avg("selfContainment"),
      structuralReadability: avg("structuralReadability"),
      statisticalDensity: avg("statisticalDensity"),
      uniqueness: avg("uniqueness"),
    },
  };
}

export async function scoreCitability(
  model: TextModel,
  pages: CitabilityPageInput[],
  opts: { concurrency?: number; maxChars?: number } = {},
): Promise<{ result: CitabilityResult; scoredPages: number; llmCalls: number }> {
  const maxChars = opts.maxChars ?? 6000;
  const eligible = pages.filter((p) => p.markdown.trim().length >= 200);
  const results = await mapConcurrent(pages, opts.concurrency ?? 5, (p) => scorePageCitability(model, p, maxChars));
  const scored = results.filter((r) => !r.error).length;
  return { result: aggregateCitability(results), scoredPages: scored, llmCalls: eligible.length };
}
