import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { parseScoredJson } from "@/lib/ai/scored-json";
import type { Doc } from "./html";
import type { EeatDimension, EeatResult, EeatSignal } from "./types";

/**
 * E-E-A-T: deterministic probes over the DOM, then one model call that grades
 * the four dimensions with the probe results as ground truth. The probes are
 * what make the grade reproducible; the model is there to weigh them.
 */

export interface EeatProbe {
  key: string;
  dimension: EeatDimension;
  signal: string;
  impact: EeatSignal["impact"];
  test: ($: Doc, url: string) => boolean;
}

export const EEAT_PROBES: EeatProbe[] = [
  { key: "https", dimension: "trustworthiness", signal: "Served over HTTPS", impact: "high", test: (_, url) => url.startsWith("https://") },
  { key: "author_byline", dimension: "expertise", signal: "Author byline present", impact: "high", test: ($) => $('[class*="author" i], [rel="author"], [itemprop="author"], .byline').length > 0 },
  { key: "author_meta", dimension: "expertise", signal: "Author metadata (meta/article:author)", impact: "medium", test: ($) => $('meta[name="author"], meta[property="article:author"]').length > 0 },
  { key: "author_bio_link", dimension: "expertise", signal: "Author links to a bio or profile page", impact: "medium", test: ($) => $('a[href*="/author/"], a[href*="/authors/"], a[href*="/team/"], a[rel="author"]').length > 0 },
  { key: "dates", dimension: "experience", signal: "Publication/modification dates visible", impact: "medium", test: ($) => $("time[datetime], meta[property='article:published_time'], meta[property='article:modified_time']").length > 0 },
  { key: "first_person", dimension: "experience", signal: "First-hand experience language (we tested, our data, in our experience)", impact: "medium", test: ($) => /\b(we (tested|measured|found|ran|built|benchmarked)|our (data|tests?|customers|experience)|in (my|our) experience|hands-on)\b/i.test($("main, article, body").first().text()) },
  { key: "original_media", dimension: "experience", signal: "Original screenshots, charts or tables", impact: "low", test: ($) => $("table").length > 0 || $('img[src*="screenshot" i], img[alt*="screenshot" i], figure').length > 0 },
  { key: "contact", dimension: "trustworthiness", signal: "Contact page or email/phone link", impact: "high", test: ($) => $('a[href*="/contact" i], a[href^="mailto:"], a[href^="tel:"], [class*="contact" i]').length > 0 },
  { key: "privacy", dimension: "trustworthiness", signal: "Privacy policy linked", impact: "medium", test: ($) => $('a[href*="privacy" i]').length > 0 },
  { key: "terms", dimension: "trustworthiness", signal: "Terms of service linked", impact: "low", test: ($) => $('a[href*="terms" i]').length > 0 },
  { key: "about", dimension: "authoritativeness", signal: "About page linked", impact: "medium", test: ($) => $('a[href*="/about" i], a[href*="/company" i]').length > 0 },
  { key: "org_schema", dimension: "authoritativeness", signal: "Organization/Person structured data", impact: "high", test: ($) => $('script[type="application/ld+json"]').toArray().some((el) => /"@type"\s*:\s*"?(Organization|Person|Corporation)/.test($(el).text())) },
  { key: "social_proof", dimension: "authoritativeness", signal: "Links to authoritative external profiles (LinkedIn, GitHub, Wikipedia…)", impact: "medium", test: ($) => $('a[href*="linkedin.com"], a[href*="github.com"], a[href*="wikipedia.org"], a[href*="crunchbase.com"], a[href*="g2.com"]').length > 0 },
  { key: "citations", dimension: "expertise", signal: "Outbound citations to sources", impact: "medium", test: ($, url) => { const host = safeHost(url); return $("main a[href^='http'], article a[href^='http']").toArray().filter((a) => safeHost($(a).attr("href") ?? "") !== host).length >= 2; } },
  { key: "editorial", dimension: "trustworthiness", signal: "Editorial policy / review process referenced", impact: "low", test: ($) => $('[class*="editorial" i], [class*="reviewed" i], a[href*="editorial" i], a[href*="methodology" i]').length > 0 || /\b(medically|fact[- ]checked|reviewed by|editorial (policy|standards))\b/i.test($("body").text()) },
];

function safeHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function runEeatProbes(pages: { $: Doc; url: string }[]): EeatSignal[] {
  return EEAT_PROBES.map((p) => ({
    dimension: p.dimension,
    signal: p.signal,
    impact: p.impact,
    present: pages.some(({ $, url }) => {
      try {
        return p.test($, url);
      } catch {
        return false;
      }
    }),
  }));
}

/** Probe-only fallback so the dimension still reads when the model is unavailable. */
export function scoreEeatFromProbes(signals: EeatSignal[]): Omit<EeatResult, "signals"> {
  const weight = { high: 3, medium: 2, low: 1 } as const;
  const dims: EeatDimension[] = ["experience", "expertise", "authoritativeness", "trustworthiness"];
  const out = { experience: 0, expertise: 0, authoritativeness: 0, trustworthiness: 0 };
  for (const d of dims) {
    const mine = signals.filter((s) => s.dimension === d);
    const max = mine.reduce((n, s) => n + weight[s.impact], 0);
    const got = mine.filter((s) => s.present).reduce((n, s) => n + weight[s.impact], 0);
    out[d] = max === 0 ? 0 : Math.round((got / max) * 25);
  }
  return { ...out, totalScore: out.experience + out.expertise + out.authoritativeness + out.trustworthiness };
}

const dim = z.number().min(0).max(25);
const EeatModelSchema = z.object({
  experience: dim,
  expertise: dim,
  authoritativeness: dim,
  trustworthiness: dim,
  rationale: z.string().optional(),
});

export async function assessEeat(
  model: TextModel,
  pages: { $: Doc; url: string; markdown: string }[],
  opts: { maxChars?: number } = {},
): Promise<{ result: EeatResult; usedModel: boolean }> {
  const signals = runEeatProbes(pages);
  const home = pages[0];
  const excerpt = home ? home.markdown.slice(0, opts.maxChars ?? 6000) : "";
  const probeTable = signals.map((s) => `- [${s.present ? "x" : " "}] (${s.dimension}, ${s.impact}) ${s.signal}`).join("\n");

  const prompt = `You are grading a website's E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness) as an AI search engine would weigh it when deciding whether to cite it.

Deterministic probe results across ${pages.length} sampled page(s):
${probeTable}

Homepage excerpt (markdown):
"""
${excerpt}
"""

Score each dimension 0-25. Treat the probe checklist as ground truth about what is present; use the excerpt to judge quality (e.g. an author byline that says "Admin" is weak). Reply with JSON only:
{"experience": n, "expertise": n, "authoritativeness": n, "trustworthiness": n, "rationale": "one sentence"}`;

  try {
    const { text } = await model.complete(prompt, { json: true, maxTokens: 400 });
    const graded = parseScoredJson(text, EeatModelSchema);
    const totalScore = Math.round(graded.experience + graded.expertise + graded.authoritativeness + graded.trustworthiness);
    return {
      result: {
        experience: Math.round(graded.experience),
        expertise: Math.round(graded.expertise),
        authoritativeness: Math.round(graded.authoritativeness),
        trustworthiness: Math.round(graded.trustworthiness),
        totalScore,
        signals,
      },
      usedModel: true,
    };
  } catch {
    return { result: { ...scoreEeatFromProbes(signals), signals }, usedModel: false };
  }
}
