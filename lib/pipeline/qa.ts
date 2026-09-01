import { runPageRules, type StructureScore } from "@/lib/aeo/rules";
import { htmlToMarkdown, parseHtml } from "@/lib/audit/html";
import { validateArticleJsonLd } from "@/lib/render/jsonld";
import { assertNoEdgeHostname } from "@/lib/tenancy/urls";
import { MARKER_RE, markerKeys, resolveMarkers } from "./markdown";
import type { Intent, QaGateResult, QaReport, SourceSpec } from "./types";

/**
 * QA gates. Deterministic wherever possible; each gate writes one row to
 * content.qa_results and a failure routes back to a specific stage.
 *
 * The sources gate is the one that separates us from volume tools: a
 * statistic without a `{{src:key}}` marker is a hard failure, every marker
 * must resolve to a ledger row, and (when a fetcher is supplied) the recorded
 * verbatim quote must appear at the URL. A string assertion, not a judgment.
 */

// Numbers that are claims. Deliberately narrower than the audit's STAT_RE:
// a bare year in prose is not a statistic that needs a citation.
export const NUMERIC_CLAIM_RE = /(\d+(\.\d+)?\s?%|\$\s?\d[\d,.]*\s?(k|m|b|million|billion)?\b|\b\d{1,3}(,\d{3})+\b|\b\d+(\.\d+)?x\b|\b\d+(\.\d+)?\s?(million|billion|percent)\b)/i;

const PLACEHOLDER_RE = /\{\{(?!\s*src:)[^}]*\}\}|\[(?:citation needed|todo|tbd|insert[^\]]*|placeholder)\]|\bTODO\b|\bTBD\b|lorem ipsum|\bXX+\b/i;

export const BANNED_PHRASES = [
  "delve into", "delves into", "in today's fast-paced", "in the ever-evolving", "ever-changing landscape", "game-changer", "game changer",
  "unlock the power", "unleash", "it's important to note", "it is important to note", "in conclusion,", "at the end of the day",
  "cutting-edge", "seamlessly", "robust solution", "a testament to", "navigating the", "in the realm of", "leverage the power",
  "revolutionize", "elevate your", "look no further", "dive deep", "deep dive into", "in this article, we", "let's explore", "buckle up",
];

/** Coefficient of variation floor for sentence length. Human prose varies; model prose is suspiciously uniform. */
export const SENTENCE_CV_MIN = 0.35;

export interface QaInput {
  title: string;
  /** Body markdown with `{{src:key}}` markers still in place. */
  bodyMd: string;
  /** Body HTML after marker resolution and rendering (what will be published). */
  bodyHtml: string;
  sources: SourceSpec[];
  intent: Intent;
  jsonLd?: unknown;
  now?: Date;
}

export interface QaOptions {
  structureMin?: number;
  /** Supply a fetcher to live-verify every cited source. Omit to skip (offline / tests). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// ── structure ──────────────────────────────────────────────────────────────

export function structureGate(input: QaInput, min: number): QaGateResult & { structure: StructureScore } {
  const html = `<!doctype html><html><head><title>${escapeHtml(input.title)}</title></head><body><main><h1>${escapeHtml(input.title)}</h1>${input.bodyHtml}</main></body></html>`;
  const $ = parseHtml(html);
  const structure = runPageRules({ url: "https://preview.invalid/", html, $, markdown: htmlToMarkdown(html), intent: input.intent, now: input.now });
  const failing = structure.findings.filter((f) => !f.passed && !f.notApplicable);
  return {
    gate: "structure",
    passed: structure.normalized >= min,
    detail: { normalized: structure.normalized, min, failing: failing.map((f) => ({ key: f.key, recommendation: f.recommendation, evidence: f.evidence })) },
    structure,
  };
}

// ── sources ────────────────────────────────────────────────────────────────

export interface UnmarkedStatistic {
  paragraph: number;
  sentence: string;
}

/** Sentences carrying a numeric claim whose paragraph has no citation marker. */
export function unmarkedStatistics(bodyMd: string): UnmarkedStatistic[] {
  const out: UnmarkedStatistic[] = [];
  const paragraphs = bodyMd.split(/\n\s*\n/);
  paragraphs.forEach((para, i) => {
    const p = para.trim();
    if (!p || p.startsWith("#") || p.startsWith("```") || p.startsWith("|")) return; // headings, code, tables are handled by their own rules
    if (MARKER_RE.test(p)) {
      MARKER_RE.lastIndex = 0;
      return;
    }
    MARKER_RE.lastIndex = 0;
    for (const sentence of p.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
      if (NUMERIC_CLAIM_RE.test(sentence)) out.push({ paragraph: i, sentence: sentence.slice(0, 200) });
    }
  });
  return out;
}

export interface SourceVerification {
  key: string;
  url: string;
  verified: boolean;
  status: number | null;
  reason: string | null;
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, (c) => ("‘’".includes(c) ? "'" : '"'))
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch each source and assert its verbatim quote appears in the page text. */
export async function verifySources(sources: SourceSpec[], fetchImpl: typeof fetch, timeoutMs = 15_000): Promise<SourceVerification[]> {
  return Promise.all(
    sources.map(async (src): Promise<SourceVerification> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(src.url, { signal: ctl.signal, headers: { "user-agent": "aeo-platform-source-verifier/1.0", accept: "text/html,text/plain,*/*" }, redirect: "follow" });
        if (!res.ok) return { key: src.key, url: src.url, verified: false, status: res.status, reason: `http ${res.status}` };
        const body = await res.text();
        const $ = parseHtml(body);
        $("script, style, noscript, svg").remove();
        const text = normalizeForMatch($("body").length ? $("body").text() : body);
        const quote = normalizeForMatch(src.quote);
        if (text.includes(quote)) return { key: src.key, url: src.url, verified: true, status: res.status, reason: null };
        // Tolerate a trailing-punctuation or quote-boundary drift, nothing looser.
        const loose = quote.replace(/[.,;:!?"']+$/g, "");
        if (loose.length >= 8 && text.includes(loose)) return { key: src.key, url: src.url, verified: true, status: res.status, reason: "matched without trailing punctuation" };
        return { key: src.key, url: src.url, verified: false, status: res.status, reason: "quote not found at url" };
      } catch (e) {
        return { key: src.key, url: src.url, verified: false, status: null, reason: `fetch failed: ${(e as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

export async function sourcesGate(input: QaInput, opts: QaOptions): Promise<QaGateResult & { verifications: SourceVerification[] }> {
  const { unresolved, cited } = resolveMarkers(input.bodyMd, input.sources);
  const unmarked = unmarkedStatistics(input.bodyMd);
  const verifications = opts.fetchImpl ? await verifySources(cited, opts.fetchImpl, opts.timeoutMs) : [];
  const failedVerification = verifications.filter((v) => !v.verified);
  const passed = unresolved.length === 0 && unmarked.length === 0 && failedVerification.length === 0;
  return {
    gate: "sources",
    passed,
    detail: {
      markers: markerKeys(input.bodyMd).length,
      cited: cited.map((s) => s.key),
      unresolved,
      unmarkedStatistics: unmarked,
      verified: opts.fetchImpl ? verifications.filter((v) => v.verified).length : null,
      failedVerification,
    },
    verifications,
  };
}

// ── mechanics ──────────────────────────────────────────────────────────────

export function mechanicsGate(input: QaInput): QaGateResult {
  const problems: string[] = [];
  const placeholder = input.bodyMd.match(PLACEHOLDER_RE);
  if (placeholder) problems.push(`placeholder text: "${placeholder[0]}"`);
  try {
    assertNoEdgeHostname(input.bodyHtml, "article body");
  } catch (e) {
    problems.push((e as Error).message);
  }
  const $ = parseHtml(`<body>${input.bodyHtml}</body>`);
  $("a").each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    if (!href || href === "#") problems.push(`empty link: "${$(a).text().trim().slice(0, 60)}"`);
  });
  $("img").each((_, img) => {
    if (!($(img).attr("alt") ?? "").trim()) problems.push(`image without alt: ${$(img).attr("src") ?? "?"}`);
  });
  if ($("h1").length > 0) problems.push("body contains an H1 (the document layer owns the title)");
  if (input.jsonLd !== undefined) {
    const issues = validateArticleJsonLd(input.jsonLd as Record<string, unknown>);
    for (const i of issues) problems.push(`json-ld: ${i}`);
  }
  return { gate: "mechanics", passed: problems.length === 0, detail: { problems } };
}

// ── slop ───────────────────────────────────────────────────────────────────

export function sentenceLengthCv(text: string): { sentences: number; mean: number; cv: number } {
  const lengths = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().split(" ").filter(Boolean).length)
    .filter((n) => n >= 3);
  if (lengths.length < 2) return { sentences: lengths.length, mean: lengths[0] ?? 0, cv: 0 };
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  return { sentences: lengths.length, mean: Math.round(mean * 10) / 10, cv: mean === 0 ? 0 : Math.round((Math.sqrt(variance) / mean) * 100) / 100 };
}

export function slopGate(input: QaInput): QaGateResult {
  const $ = parseHtml(`<body>${input.bodyHtml}</body>`);
  const text = $("body").text();
  const lower = text.toLowerCase();
  const banned = BANNED_PHRASES.filter((p) => lower.includes(p));
  const cv = sentenceLengthCv(text);
  const uniform = cv.sentences >= 10 && cv.cv < SENTENCE_CV_MIN;
  return {
    gate: "slop",
    passed: banned.length === 0 && !uniform,
    detail: { bannedPhrases: banned, sentenceLength: cv, uniform, cvMin: SENTENCE_CV_MIN },
  };
}

// ── report ─────────────────────────────────────────────────────────────────

export function structureMinFrom(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AEO_QA_STRUCTURE_MIN);
  return Number.isFinite(n) && n > 0 ? n : 65;
}

export async function runQaGates(input: QaInput, opts: QaOptions = {}): Promise<QaReport & { structure: StructureScore; verifications: SourceVerification[] }> {
  const min = opts.structureMin ?? structureMinFrom(opts.env);
  const structure = structureGate(input, min);
  const sources = await sourcesGate(input, opts);
  const mechanics = mechanicsGate(input);
  const slop = slopGate(input);
  const gates: QaGateResult[] = [structure, sources, mechanics, slop].map(({ gate, passed, detail }) => ({ gate, passed, detail }));
  const feedback = feedbackFor({ structure, sources, mechanics, slop });
  const passed = gates.every((g) => g.passed);
  // A draft with numbers and a brief that supplied nothing to cite is the
  // brief's failure, not the drafter's.
  const briefLacksSources = !sources.passed && input.sources.length === 0 && (sources.detail.unmarkedStatistics as unknown[]).length > 0;
  const routeTo: QaReport["routeTo"] = passed ? null : briefLacksSources ? "brief" : "draft";
  return { passed, gates, routeTo, feedback, structure: structure.structure, verifications: sources.verifications };
}

function feedbackFor(g: { structure: ReturnType<typeof structureGate>; sources: Awaited<ReturnType<typeof sourcesGate>>; mechanics: QaGateResult; slop: QaGateResult }): string[] {
  const out: string[] = [];
  if (!g.structure.passed) {
    out.push(`Structure score ${g.structure.detail.normalized} is below ${g.structure.detail.min}.`);
    for (const f of g.structure.detail.failing as { key: string; recommendation?: string }[]) if (f.recommendation) out.push(`[${f.key}] ${f.recommendation}`);
  }
  const d = g.sources.detail;
  for (const k of d.unresolved as string[]) out.push(`Marker {{src:${k}}} does not match any provided source; only cite the sources you were given.`);
  for (const u of d.unmarkedStatistics as UnmarkedStatistic[]) out.push(`Statistic without a citation marker — cite a provided source or remove the number: "${u.sentence}"`);
  for (const v of d.failedVerification as SourceVerification[]) out.push(`Source ${v.key} could not be verified at ${v.url} (${v.reason}); do not cite it.`);
  for (const p of g.mechanics.detail.problems as string[]) out.push(`Mechanics: ${p}`);
  const banned = g.slop.detail.bannedPhrases as string[];
  if (banned.length) out.push(`Remove these phrases: ${banned.map((b) => `"${b}"`).join(", ")}.`);
  if (g.slop.detail.uniform) out.push("Sentence lengths are too uniform; vary rhythm — mix short declarative sentences with longer ones.");
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
