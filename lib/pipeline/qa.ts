import { runPageRules, type StructureScore } from "@/lib/aeo/rules";
import { htmlToMarkdown, parseHtml } from "@/lib/audit/html";
import { safeFetch } from "@/lib/fetch";
import { validateArticleJsonLd } from "@/lib/render/jsonld";
import { assertNoEdgeHostname } from "@/lib/tenancy/urls";
import { ANY_MARKER_RE, factMarkerKeys, markerKeys, resolveMarkers, splitFaqSection, stripFactMarkers } from "./markdown";
import type { BriefFact, Intent, QaGateResult, QaReport, SourceSpec } from "./types";

/**
 * QA gates. Deterministic wherever possible; each gate writes one row to
 * content.qa_results and a failure routes back to a specific stage.
 *
 * The sources gate is the one that separates us from volume tools: a
 * statistic without a `{{src:key}}` marker is a hard failure, every marker
 * must resolve to a ledger row, and (when a fetcher is supplied) the recorded
 * verbatim quote must appear at the URL. A string assertion, not a judgment.
 * Those URLs come from model output, so in production they are fetched
 * through safeFetch: SSRF-checked on every redirect hop, size-capped.
 *
 * The grounding gate is its twin for the company's own claims: every
 * `{{fact:key}}` must be a fact the brief offered, still verified, currently
 * effective and public — and when the brain offered enough public facts, a
 * draft that cites none of them is generic by construction and fails.
 *
 * The safety gate looks for what must never reach a public page unseen: an
 * email address, a customer or internal statement from the brand brain, a
 * deal or revenue figure, an instruction aimed at a model, zero-width
 * characters, hidden text. It does not fail the draft (an article about ARR
 * may say ARR); it hands it to a person (QaReport.requiresHuman).
 *
 * The scope gate runs on a figures-and-dates update (update_stats) of a page
 * that is winning: the draft keeps the live page's title, its headings in
 * their order and about its length, numbers aside. The prompt asks for that;
 * this checks it, and a draft that rewrote the page goes back with the
 * headings it must keep.
 */

// Numbers that are claims. Deliberately narrower than the audit's STAT_RE:
// a bare year in prose is not a statistic that needs a citation.
export const NUMERIC_CLAIM_RE = /(\d+(\.\d+)?\s?%|\$\s?\d[\d,.]*\s?(k|m|b|million|billion)?\b|\b\d{1,3}(,\d{3})+\b|\b\d+(\.\d+)?x\b|\b\d+(\.\d+)?\s?(million|billion|percent)\b)/i;

const PLACEHOLDER_RE = /\{\{(?!\s*(?:src|fact):)[^}]*\}\}|\[(?:citation needed|todo|tbd|insert[^\]]*|placeholder)\]|\bTODO\b|\bTBD\b|lorem ipsum|\bXX+\b/i;

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
  /** The meta description, checked by the safety gate. */
  description?: string;
  /** FAQ entries as published, checked by the safety gate. */
  faq?: { question: string; answer: string }[];
  /**
   * False when the brief found no evidence for an FAQ (BriefSpec.allowFaq):
   * the structure gate does not score or ask for one, and an FAQ section in
   * the body fails mechanics.
   */
  allowFaq?: boolean;
  /** Body markdown with `{{src:key}}` markers still in place. */
  bodyMd: string;
  /** Body HTML after marker resolution and rendering (what will be published). */
  bodyHtml: string;
  sources: SourceSpec[];
  /** Verified facts the brief offered the draft (may be empty: no brain, or none verified yet). */
  facts?: BriefFact[];
  intent: Intent;
  jsonLd?: unknown;
  /**
   * The full article document (composeQaDocument). When present the
   * structure gate scores it, so head, JSON-LD, byline and dates count the
   * way they will on the published page.
   */
  documentHtml?: string;
  /** The article's canonical URL, scored as the page URL with documentHtml. */
  canonicalUrl?: string;
  /**
   * A figures-and-dates update: the live page it updates (loadExistingContent;
   * `truncated` when its body was cut to fit the prompt, so only the headings
   * it shows can be held to). Present, it turns on the scope gate.
   */
  keep?: { title: string; bodyMd: string; truncated?: boolean };
  now?: Date;
}

export interface FactCheck {
  id: string;
  status: string;
  visibility: string;
  effective: boolean;
}

export interface QaOptions {
  structureMin?: number;
  /** Live-verify every cited source with this fetcher (production: safeSourceFetcher()). Omit both to skip. */
  fetchSource?: SourceFetcher;
  /** A raw fetch, for tests and fixtures; fetchSource wins when both are given. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Live check of cited fact ids (exists, verified, effective). Omit to trust the brief's snapshot (tests). */
  loadFacts?: (ids: string[]) => Promise<FactCheck[]>;
  /** Public facts the brief must offer before "cites none of them" is a failure. */
  minOrgFacts?: number;
  /**
   * Names and statements that must not be published (lib/context/facts.ts
   * loadInternalTerms: customers no public fact names, internal facts). Omit
   * to skip that check.
   */
  loadInternalTerms?: () => Promise<string[]>;
}

// ── structure ──────────────────────────────────────────────────────────────

export function structureGate(input: QaInput, min: number): QaGateResult & { structure: StructureScore } {
  const html =
    input.documentHtml ??
    `<!doctype html><html><head><title>${escapeHtml(input.title)}</title></head><body><main><h1>${escapeHtml(input.title)}</h1>${input.bodyHtml}</main></body></html>`;
  const $ = parseHtml(html);
  const url = (input.documentHtml && input.canonicalUrl) || "https://preview.invalid/";
  const structure = runPageRules({ url, html, $, markdown: htmlToMarkdown(html), intent: input.intent, faqExpected: input.allowFaq, now: input.now });
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
    if (ANY_MARKER_RE.test(p)) {
      ANY_MARKER_RE.lastIndex = 0;
      return;
    }
    ANY_MARKER_RE.lastIndex = 0;
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

/** Fetch one cited URL: status and body, or a throw (blocked, unreachable, timed out). */
export type SourceFetcher = (url: string, timeoutMs: number) => Promise<{ status: number; ok: boolean; body: string }>;

const VERIFIER_USER_AGENT = "aeo-platform-source-verifier/1.0";
const VERIFIER_ACCEPT = "text/html,text/plain,*/*";
/** A source page larger than this is truncated; the quote is near the top of anything we would cite. */
export const SOURCE_MAX_BYTES = 2_000_000;

/**
 * The production fetcher: safeFetch refuses private, loopback and metadata
 * addresses (literal or resolved) on every redirect hop and caps the body.
 * No retries: a flaky source fails verification and the draft drops it.
 * `timeoutMs` is one deadline for the whole fetch, redirects and body
 * included: a source that sends headers and then stalls must not hold the
 * draft step (and its model call) past the route's time limit.
 */
export function safeSourceFetcher(fetchImpl?: typeof fetch): SourceFetcher {
  return async (url, timeoutMs) => {
    const res = await safeFetch(url, {
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      maxBytes: SOURCE_MAX_BYTES,
      maxRetries: 0,
      userAgent: VERIFIER_USER_AGENT,
      headers: { accept: VERIFIER_ACCEPT },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    return { status: res.status, ok: res.ok, body: res.body };
  };
}

/** A bare fetch as a SourceFetcher, for tests and fixtures. No SSRF checks. */
export function plainSourceFetcher(fetchImpl: typeof fetch): SourceFetcher {
  return async (url, timeoutMs) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { "user-agent": VERIFIER_USER_AGENT, accept: VERIFIER_ACCEPT }, redirect: "follow" });
      return { status: res.status, ok: res.ok, body: res.ok ? await res.text() : "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Fetch each source and assert its verbatim quote appears in the page text. */
export async function verifySources(sources: SourceSpec[], fetchImpl: typeof fetch, timeoutMs = 15_000): Promise<SourceVerification[]> {
  return verifySourcesWith(sources, plainSourceFetcher(fetchImpl), timeoutMs);
}

export async function verifySourcesWith(sources: SourceSpec[], fetchSource: SourceFetcher, timeoutMs = 15_000): Promise<SourceVerification[]> {
  return Promise.all(
    sources.map(async (src): Promise<SourceVerification> => {
      try {
        const res = await fetchSource(src.url, timeoutMs);
        if (!res.ok) return { key: src.key, url: src.url, verified: false, status: res.status, reason: `http ${res.status}` };
        const body = res.body;
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
      }
    }),
  );
}

export async function sourcesGate(input: QaInput, opts: QaOptions): Promise<QaGateResult & { verifications: SourceVerification[] }> {
  const { unresolved, cited } = resolveMarkers(input.bodyMd, input.sources);
  const unmarked = unmarkedStatistics(input.bodyMd);
  const fetchSource = opts.fetchSource ?? (opts.fetchImpl ? plainSourceFetcher(opts.fetchImpl) : null);
  const verifications = fetchSource ? await verifySourcesWith(cited, fetchSource, opts.timeoutMs) : [];
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
      verified: fetchSource ? verifications.filter((v) => v.verified).length : null,
      failedVerification,
    },
    verifications,
  };
}

// ── grounding ──────────────────────────────────────────────────────────────

export const MIN_ORG_FACTS_DEFAULT = 2;

export interface GroundingDetail {
  cited: string[];
  unknown: string[];
  stale: { key: string; reason: string }[];
  nonPublic: string[];
  offeredPublic: number;
  required: number;
  citedFacts: BriefFact[];
}

/**
 * Every `{{fact:key}}` resolves to an offered, public fact that is (still)
 * verified and effective. Originality: when the brain offered at least
 * `minOrgFacts` public facts, the draft must cite at least one — otherwise
 * it would read the same under a competitor's byline.
 */
export async function groundingGate(input: QaInput, opts: QaOptions = {}): Promise<QaGateResult & { detail: GroundingDetail }> {
  const offered = input.facts ?? [];
  const byKey = new Map(offered.map((f) => [f.key, f]));
  const cited = factMarkerKeys(input.bodyMd);
  const unknown = cited.filter((k) => !byKey.has(k));
  const known = cited.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
  const nonPublic = known.filter((f) => f.visibility !== "public").map((f) => f.key);
  const stale: GroundingDetail["stale"] = [];
  if (opts.loadFacts && known.length) {
    const checks = new Map((await opts.loadFacts(known.map((f) => f.factId))).map((c) => [c.id, c]));
    for (const f of known) {
      const c = checks.get(f.factId);
      if (!c) stale.push({ key: f.key, reason: "fact no longer exists" });
      else if (c.status !== "verified") stale.push({ key: f.key, reason: `fact is ${c.status}` });
      else if (!c.effective) stale.push({ key: f.key, reason: "fact is not currently effective" });
    }
  }
  const offeredPublic = offered.filter((f) => f.visibility === "public").length;
  const required = offeredPublic >= (opts.minOrgFacts ?? MIN_ORG_FACTS_DEFAULT) ? 1 : 0;
  const citedFacts = known.filter((f) => f.visibility === "public" && !stale.some((s) => s.key === f.key));
  const passed = unknown.length === 0 && nonPublic.length === 0 && stale.length === 0 && citedFacts.length >= required;
  return { gate: "grounding", passed, detail: { cited, unknown, stale, nonPublic, offeredPublic, required, citedFacts } };
}

// ── mechanics ──────────────────────────────────────────────────────────────

export function mechanicsGate(input: QaInput): QaGateResult {
  const problems: string[] = [];
  const placeholder = stripFactMarkers(input.bodyMd).match(PLACEHOLDER_RE);
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
  const faqSections = $("h2").filter((_, h) => /^\s*frequently asked questions\s*$/i.test($(h).text())).length;
  if (faqSections > 1) problems.push(`the FAQ section appears ${faqSections} times; return FAQ entries only in the faq array, never as a section in bodyMd`);
  // No evidence buyers ask these as separate questions: an FAQ written into the body is the one the brief left out.
  if (input.allowFaq === false && splitFaqSection(input.bodyMd).faq.length > 0) problems.push("the body has an FAQ section, but this article has none: answer those questions in its sections and return an empty faq array");
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

// ── safety ─────────────────────────────────────────────────────────────────

export type SafetyKind = "email" | "internal_term" | "deal_figure" | "instruction" | "zero_width" | "hidden_text";

export interface SafetyFinding {
  kind: SafetyKind;
  where: "title" | "description" | "body" | "faq";
  match: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Revenue acronyms are matched in capitals only ("arr" in prose is a typo, not a deal); amounts tied to a deal word in any case.
const DEAL_ACRONYM_RE = /\b(?:ARR|MRR|ACV|TCV)\b/g;
const DEAL_AMOUNT_RE = /\$\s?\d[\d,.]*\s?(?:k|m|mm|bn|b|million|billion)?\b[^.\n]{0,40}?\b(?:contract|deal|renewal|purchase order)s?\b/gi;
// "Ignore all instructions" needs no qualifier ("all" is the tell); "ignore the instructions" alone is prose, so it needs one ("previous", "prior"…).
const INSTRUCTION_RE =
  /\b(?:ignore|disregard|forget)\s+(?:all\s+(?:(?:the|your|of\s+the|of\s+your)\s+)?(?:(?:previous|prior|above|earlier|preceding)\s+)?|(?:any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+)(?:instructions|prompts?|directions|rules)\b|\bsystem prompt\b|<\s*\/?\s*system\s*>|&lt;\s*\/?\s*system\s*&gt;/gi;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF]/g;
// Hiding styles and attributes in the markup the model wrote (the sanitiser strips them, but the intent to hide is the finding), and HTML comments the sanitiser keeps.
const HIDDEN_STYLE_RE = /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*(?:[;"']|!)|opacity\s*:\s*0(?:\.0+)?\s*(?:[;"']|!)|color\s*:\s*transparent|(?:left|top|text-indent)\s*:\s*-\d{3,})/gi;
const HIDDEN_ATTR_RE = /<[a-z][^>]*\s(?:hidden|aria-hidden\s*=\s*["']?true)\b[^>]*>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  const out = [...text.matchAll(re)].map((m) => m[0]);
  re.lastIndex = 0;
  return out;
}

/** Every finding, by where it is. Pure; `internalTerms` are matched as whole words, case-insensitive. */
export function safetyFindings(input: Pick<QaInput, "title" | "description" | "bodyMd" | "bodyHtml" | "faq">, internalTerms: string[] = []): SafetyFinding[] {
  const fields: { where: SafetyFinding["where"]; text: string; markup: boolean }[] = [
    { where: "title", text: input.title, markup: false },
    { where: "description", text: input.description ?? "", markup: false },
    { where: "body", text: `${input.bodyMd}\n${input.bodyHtml}`, markup: true },
    { where: "faq", text: (input.faq ?? []).map((f) => `${f.question}\n${f.answer}`).join("\n"), markup: false },
  ];
  const terms = [...new Set(internalTerms.map((t) => t.trim()).filter((t) => t.length >= 3))].map((t) => ({
    term: t,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu"),
  }));
  const out: SafetyFinding[] = [];
  const seen = new Set<string>();
  const add = (kind: SafetyKind, where: SafetyFinding["where"], match: string) => {
    const key = `${kind}|${where}|${match.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, where, match: match.slice(0, 120) });
  };
  for (const f of fields) {
    if (!f.text) continue;
    // Body text without the markup: the address in a mailto link is the same address, once.
    const plain = f.markup ? `${input.bodyMd}\n${parseHtml(`<body>${input.bodyHtml}</body>`)("body").text()}` : f.text;
    for (const m of matches(EMAIL_RE, plain)) add("email", f.where, m);
    for (const m of matches(DEAL_ACRONYM_RE, plain)) add("deal_figure", f.where, m);
    for (const m of matches(DEAL_AMOUNT_RE, plain)) add("deal_figure", f.where, m);
    for (const m of matches(INSTRUCTION_RE, f.text)) add("instruction", f.where, m);
    for (const m of matches(ZERO_WIDTH_RE, f.text)) add("zero_width", f.where, `U+${m.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    for (const t of terms) {
      const m = plain.match(t.re);
      if (m) add("internal_term", f.where, m[0]);
    }
    if (f.markup) {
      for (const m of matches(HIDDEN_STYLE_RE, f.text)) add("hidden_text", f.where, m);
      for (const m of matches(HIDDEN_ATTR_RE, f.text)) add("hidden_text", f.where, m);
      for (const m of matches(HTML_COMMENT_RE, f.text)) if (m.replace(/<!--|-->/g, "").trim()) add("hidden_text", f.where, m);
    }
  }
  return out;
}

const SAFETY_LABELS: Record<SafetyKind, string> = {
  email: "an email address",
  internal_term: "a customer or internal statement",
  deal_figure: "a deal or revenue figure",
  instruction: "an instruction aimed at a model",
  zero_width: "zero-width characters",
  hidden_text: "hidden text",
};

export async function safetyGate(input: QaInput, opts: QaOptions = {}): Promise<QaGateResult & { findings: SafetyFinding[] }> {
  const terms = opts.loadInternalTerms ? await opts.loadInternalTerms() : [];
  const findings = safetyFindings(input, terms);
  return {
    gate: "safety",
    passed: findings.length === 0,
    detail: { findings, kinds: [...new Set(findings.map((f) => f.kind))], internalTermsChecked: terms.length, blocking: false },
    findings,
  };
}

/** One line per kind, for a reviewer's notice and a regenerate prompt. */
export function safetySummary(findings: SafetyFinding[]): string[] {
  const byKind = new Map<SafetyKind, string[]>();
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.match]);
  return [...byKind.entries()].map(([kind, ms]) => `${SAFETY_LABELS[kind]}: ${[...new Set(ms)].slice(0, 3).map((m) => `"${m}"`).join(", ")}`);
}

// ── scope ──────────────────────────────────────────────────────────────────

/** How far a figures-and-dates update may move the length: the wording stays, so the word count does too. */
export const UPDATE_STATS_LENGTH_TOLERANCE = 0.25;

/** A title or heading as the scope gate compares it: its words, lower-cased, markup and punctuation out, every number masked (the figures may change). */
export function scopeKey(text: string): string {
  return normalizeForMatch(text.replace(ANY_MARKER_RE, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/[^\p{L}\p{N}#\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The H2 and H3 headings of a Markdown body in order, FAQ section aside (a draft returns its FAQ separately). */
export function sectionHeadings(md: string): string[] {
  const { bodyMd } = splitFaqSection(md);
  return [...bodyMd.matchAll(/^#{2,3}[ \t]+(.+?)[ \t#]*$/gm)].map((m) => m[1]!.trim()).filter((h) => scopeKey(h));
}

function bodyWords(md: string): number {
  return splitFaqSection(md).bodyMd.replace(ANY_MARKER_RE, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function scopeGate(input: QaInput): QaGateResult | null {
  const keep = input.keep;
  if (!keep) return null;
  const problems: string[] = [];
  if (scopeKey(input.title) !== scopeKey(keep.title)) problems.push(`the title changed: keep "${keep.title}"`);
  const live = sectionHeadings(keep.bodyMd);
  const drafted = sectionHeadings(input.bodyMd);
  const liveKeys = live.map(scopeKey);
  const draftedKeys = drafted.map(scopeKey);
  const headingsKept = liveKeys.every((k, i) => draftedKeys[i] === k) && (keep.truncated || draftedKeys.length === liveKeys.length);
  if (!headingsKept) problems.push("the headings changed: keep every heading of the live page, in its order, and add none");
  const words = { live: bodyWords(keep.bodyMd), drafted: bodyWords(input.bodyMd) };
  const drift = words.live > 0 ? Math.abs(words.drafted - words.live) / words.live : 0;
  if (!keep.truncated && drift > UPDATE_STATS_LENGTH_TOLERANCE) problems.push(`the length changed from ${words.live} to ${words.drafted} words: keep the wording, change only figures and dates`);
  return { gate: "scope", passed: problems.length === 0, detail: { problems, headings: { live, drafted }, words, tolerance: UPDATE_STATS_LENGTH_TOLERANCE, truncated: keep.truncated === true } };
}

// ── report ─────────────────────────────────────────────────────────────────

export function structureMinFrom(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AEO_QA_STRUCTURE_MIN);
  return Number.isFinite(n) && n > 0 ? n : 65;
}

export async function runQaGates(
  input: QaInput,
  opts: QaOptions = {},
): Promise<QaReport & { structure: StructureScore; verifications: SourceVerification[]; citedFacts: BriefFact[]; safety: SafetyFinding[] }> {
  const min = opts.structureMin ?? structureMinFrom(opts.env);
  const structure = structureGate(input, min);
  const sources = await sourcesGate(input, opts);
  const grounding = await groundingGate(input, opts);
  const mechanics = mechanicsGate(input);
  const slop = slopGate(input);
  const safety = await safetyGate(input, opts);
  const scope = scopeGate(input);
  const gates: QaGateResult[] = [structure, sources, grounding, mechanics, slop, safety, ...(scope ? [scope] : [])].map(({ gate, passed, detail }) => ({ gate, passed, detail }));
  const feedback = feedbackFor({ structure, sources, grounding, mechanics, slop, safety, scope });
  // Safety routes to a person, not to a rewrite: it never fails the draft on its own.
  const passed = gates.every((g) => g.passed || g.gate === "safety");
  // A draft with numbers and a brief that supplied nothing to cite is the
  // brief's failure, not the drafter's; so is a fact that went stale under it.
  const briefLacksSources = !sources.passed && input.sources.length === 0 && (sources.detail.unmarkedStatistics as unknown[]).length > 0;
  const briefIsStale = grounding.detail.stale.length > 0;
  const routeTo: QaReport["routeTo"] = passed ? null : briefLacksSources || briefIsStale ? "brief" : "draft";
  return {
    passed,
    gates,
    routeTo,
    feedback,
    requiresHuman: safety.findings.length > 0,
    structure: structure.structure,
    verifications: sources.verifications,
    citedFacts: grounding.detail.citedFacts,
    safety: safety.findings,
  };
}

function feedbackFor(g: {
  structure: ReturnType<typeof structureGate>;
  sources: Awaited<ReturnType<typeof sourcesGate>>;
  grounding: Awaited<ReturnType<typeof groundingGate>>;
  mechanics: QaGateResult;
  slop: QaGateResult;
  safety: Awaited<ReturnType<typeof safetyGate>>;
  scope: QaGateResult | null;
}): string[] {
  const out: string[] = [];
  if (g.scope && !g.scope.passed) {
    out.push(`This is a figures-and-dates update of a live page that is winning, not a rewrite: ${(g.scope.detail.problems as string[]).join("; ")}.`);
    const live = (g.scope.detail.headings as { live: string[] }).live;
    if (live.length) out.push(`Keep these headings, in this order: ${live.map((h) => `"${h}"`).join(", ")}.`);
  }
  if (!g.structure.passed) {
    out.push(`Structure score ${g.structure.detail.normalized} is below ${g.structure.detail.min}.`);
    for (const f of g.structure.detail.failing as { key: string; recommendation?: string }[]) if (f.recommendation) out.push(`[${f.key}] ${f.recommendation}`);
  }
  const d = g.sources.detail;
  for (const k of d.unresolved as string[]) out.push(`Marker {{src:${k}}} does not match any provided source; only cite the sources you were given.`);
  for (const u of d.unmarkedStatistics as UnmarkedStatistic[]) out.push(`Statistic without a citation marker — cite a provided source or remove the number: "${u.sentence}"`);
  for (const v of d.failedVerification as SourceVerification[]) out.push(`Source ${v.key} could not be verified at ${v.url} (${v.reason}); do not cite it.`);
  const gr = g.grounding.detail;
  for (const k of gr.unknown) out.push(`Marker {{fact:${k}}} is not one of the verified brand facts you were given; only cite the fact keys provided.`);
  for (const k of gr.nonPublic) out.push(`Fact {{fact:${k}}} is internal and cannot be stated in a published article; remove the claim.`);
  for (const s of gr.stale) out.push(`Fact {{fact:${s.key}}} can no longer be cited (${s.reason}).`);
  if (gr.citedFacts.length < gr.required) out.push(`The article states nothing specific to the company. Ground it in at least one of the verified brand facts provided, marked with {{fact:key}}.`);
  for (const p of g.mechanics.detail.problems as string[]) out.push(`Mechanics: ${p}`);
  const banned = g.slop.detail.bannedPhrases as string[];
  if (banned.length) out.push(`Remove these phrases: ${banned.map((b) => `"${b}"`).join(", ")}.`);
  if (g.slop.detail.uniform) out.push("Sentence lengths are too uniform; vary rhythm — mix short declarative sentences with longer ones.");
  // Only read when another gate already sends the draft back; a person reviews whatever remains.
  for (const line of safetySummary(g.safety.findings)) out.push(`Safety: remove ${line}.`);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
