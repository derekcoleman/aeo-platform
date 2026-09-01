import type postgres from "postgres";
import type { TextModel } from "@/lib/ai/model";
import { appDb } from "@/lib/db/app";
import { runJsonTask } from "./model";
import { draftOutputSchema, type BriefSpec, type DraftOutput, type ModelRun } from "./types";

/**
 * Stage 5: the draft. Monolithic for now (section-by-section with prompt
 * caching is a later optimisation); the contract that matters is already
 * here — every statistic carries a `{{src:key}}` marker to a source the brief
 * supplied, and the QA gates reject anything else.
 */

export const DRAFT_PROMPT_VERSION = "draft.v1";

export interface DraftContext {
  brief: BriefSpec;
  author: { name: string; jobTitle?: string | null };
  site: { organizationName: string; domain: string };
  /** QA feedback or a reviewer note when regenerating. */
  feedback?: string[];
  note?: string | null;
  previous?: DraftOutput | null;
}

export function draftSystemPrompt(): string {
  return [
    "You are a senior writer producing one article for a B2B software company's own site, under a named author's byline. Return strict JSON only.",
    "Hard rules — the article is checked mechanically and violations are rejected:",
    "- Any sentence with a number (percentages, dollar amounts, counts, multiples) MUST cite a provided source with a {{src:key}} marker placed in the same paragraph, and the number must be exactly what that source's quote says. If no provided source supports a number, do not write the number.",
    "- Only use the source keys you are given. Never invent a source, a study, a survey or a statistic.",
    "- bodyMd is GitHub-flavoured Markdown. Do NOT include the title as an H1; start with the answer paragraph. Headings are H2 (##) for sections, H3 (###) inside sections.",
    "- The first paragraph is the targetAnswer from the brief, lightly adapted, ≤60 words. Under every question-form H2 the first paragraph answers it directly in ≤60 words.",
    "- Every section must be understandable on its own (an AI engine may quote it in isolation). Define terms on first use.",
    "- Comparative intent requires a Markdown table comparing the options on concrete criteria.",
    "- Vary sentence length. Short sentences. Then longer ones that carry the argument. No filler, no throat-clearing, no 'in conclusion'.",
    "- Never use: delve, in today's fast-paced world, game-changer, unlock, seamless, robust, cutting-edge, landscape, leverage, elevate, dive deep, a testament to.",
    "- Respect bannedClaims absolutely. Link internally only to the internalLinks provided, using the given anchor text in Markdown link syntax.",
    "- No placeholders, no TODOs, no brackets asking for input.",
  ].join("\n");
}

export function draftPrompt(ctx: DraftContext): string {
  const b = ctx.brief;
  const parts = [
    `Company: ${ctx.site.organizationName} (${ctx.site.domain}). Author byline: ${ctx.author.name}${ctx.author.jobTitle ? `, ${ctx.author.jobTitle}` : ""}.`,
    `Title: ${b.title}\nMeta description: ${b.description}\nIntent: ${b.intent}\nHead question: ${b.headQuestion}\nTarget answer (open with this): ${b.targetAnswer}`,
    `Outline:\n${b.outline.map((s, i) => `${i + 1}. ${s.heading}${s.goal ? ` — ${s.goal}` : ""}${s.sourceKeys.length ? ` [sources: ${s.sourceKeys.join(", ")}]` : ""}`).join("\n")}`,
    b.faq.length ? `FAQ questions to answer (return them in the faq array, not in bodyMd):\n${b.faq.map((q) => `- ${q}`).join("\n")}` : "FAQ: none.",
    b.entities.length ? `Entities to cover by name: ${b.entities.join(", ")}` : "",
    b.internalLinks.length ? `Internal links (use each once):\n${b.internalLinks.map((l) => `- [${l.anchor}](${l.url})`).join("\n")}` : "Internal links: none.",
    b.pov ? `Point of view to carry through:\n${b.pov}` : "",
    b.bannedClaims.length ? `Banned claims:\n${b.bannedClaims.map((c) => `- ${c}`).join("\n")}` : "",
    b.sources.length
      ? `Sources you may cite (key → verbatim quote):\n${b.sources.map((s) => `- {{src:${s.key}}} ${s.publisher ?? ""} ${s.title ?? ""} ${s.url}\n  quote: "${s.quote}"`).join("\n")}`
      : "Sources: NONE provided. Therefore the article must contain no statistics or numeric claims at all.",
  ].filter(Boolean);
  if (ctx.previous) parts.push(`Previous draft (revise it; keep what works):\n${JSON.stringify(ctx.previous)}`);
  if (ctx.feedback?.length) parts.push(`Fix every item below before returning:\n${ctx.feedback.map((f) => `- ${f}`).join("\n")}`);
  if (ctx.note) parts.push(`Reviewer note — this takes priority:\n${ctx.note}`);
  parts.push('Return JSON: { "title": string, "description": string, "bodyMd": string, "faq": [{ "question": string, "answer": string }] }');
  return parts.join("\n\n");
}

export async function generateDraft(
  model: TextModel,
  ctx: DraftContext,
  scope: { orgId: string; siteId: string; contentItemId?: string | null },
  sql: postgres.Sql = appDb(),
): Promise<{ draft: DraftOutput; run: ModelRun }> {
  const { value, run } = await runJsonTask("pipeline.draft", model, { system: draftSystemPrompt(), prompt: draftPrompt(ctx), promptVersion: DRAFT_PROMPT_VERSION, maxTokens: 12_000, temperature: 0.5 }, draftOutputSchema, scope, sql);
  return { draft: value, run };
}

/** kebab-case slug from a title; the content_items check constraint enforces the same shape. */
export function slugify(title: string, max = 80): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "article";
}
