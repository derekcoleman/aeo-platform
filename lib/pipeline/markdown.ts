import * as cheerio from "cheerio";
import { marked } from "marked";
import type { SourceSpec } from "./types";

/**
 * Markdown is the source of truth for a version; HTML is derived here, once,
 * and stored next to it so QA gates, previews and the renderer all read the
 * same bytes. The output is the article BODY only — the document layer adds
 * the H1, byline, theme and JSON-LD.
 */

export const MARKER_RE = /\{\{\s*src:([a-z0-9][a-z0-9-]{1,63})\s*\}\}/g;
/** `{{fact:key}}` — a verified brand fact. Stays in the stored markdown as provenance; stripped from HTML (facts are ours, not footnotes). */
export const FACT_MARKER_RE = /\{\{\s*fact:([a-z0-9][a-z0-9-]{1,63})\s*\}\}/g;
export const ANY_MARKER_RE = /\{\{\s*(?:src|fact):[a-z0-9][a-z0-9-]{1,63}\s*\}\}/g;

/** The model is told not to emit a title; if it does anyway, drop it rather than render two H1s. */
export function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+[^\n]+\n+/, "");
}

export function markerKeys(md: string): string[] {
  const keys = new Set<string>();
  for (const m of md.matchAll(MARKER_RE)) keys.add(m[1]!);
  return [...keys];
}

export function factMarkerKeys(md: string): string[] {
  const keys = new Set<string>();
  for (const m of md.matchAll(FACT_MARKER_RE)) keys.add(m[1]!);
  return [...keys];
}

/** Remove fact markers (tidying the whitespace they leave) before rendering; the markdown keeps them. */
export function stripFactMarkers(md: string): string {
  return md.replace(FACT_MARKER_RE, "").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/(?<=\S)[ \t]{2,}(?=\S)/g, " ");
}

export interface ResolvedMarkers {
  markdown: string;
  /** Marker keys with no matching source — a hard failure at the sources gate. */
  unresolved: string[];
  /** Sources cited at least once, in first-citation order. */
  cited: SourceSpec[];
}

/**
 * `{{src:key}}` → a numbered superscript link to the source URL. Resolving to
 * an *external link inside the same paragraph* is what lets the shared
 * `attributed_stats` rule count the sentence as attributed, so citation
 * discipline and structure score are one mechanism, not two.
 */
export function resolveMarkers(md: string, sources: SourceSpec[]): ResolvedMarkers {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const order: string[] = [];
  const unresolved = new Set<string>();
  const markdown = md.replace(MARKER_RE, (_, key: string) => {
    const src = byKey.get(key);
    if (!src) {
      unresolved.add(key);
      return "";
    }
    if (!order.includes(key)) order.push(key);
    const n = order.indexOf(key) + 1;
    const label = (src.publisher ?? src.title ?? new URL(src.url).hostname).replace(/["\\]/g, "");
    return `[<sup>${n}</sup>](${src.url} "${label}")`;
  });
  const tidy = markdown.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/(?<=\S)[ \t]{2,}(?=\S)/g, " ");
  return { markdown: tidy, unresolved: [...unresolved], cited: order.map((k) => byKey.get(k)!) };
}

// ── article-body sanitiser ─────────────────────────────────────────────────
// Broader than lib/render/sanitize (tables, code, blockquote, sup/sub) but
// the same posture: allowlist elements and attributes, drop everything else,
// keep the text. Nothing executable survives, and every link is http(s),
// mailto or root-relative.

const ALLOWED: Record<string, readonly string[]> = {
  p: [], br: [], hr: [],
  h2: ["id"], h3: ["id"], h4: ["id"],
  ul: [], ol: ["start"], li: [],
  strong: [], em: [], b: [], i: [], u: [], s: [], del: [], ins: [], mark: [], small: [],
  sup: [], sub: [], code: [], pre: [], kbd: [],
  blockquote: ["cite"],
  a: ["href", "title", "rel", "target"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["scope", "colspan", "rowspan"], td: ["colspan", "rowspan"],
  figure: [], figcaption: [],
  dl: [], dt: [], dd: [],
  time: ["datetime"],
  span: [], div: [],
};

const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "noscript", "svg", "math", "template", "link", "meta", "base"]);

function safeUrl(value: string, allowRelative: boolean): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^(https?:)?\/\//i.test(v)) return /^\/\//.test(v) ? null : v;
  if (/^mailto:/i.test(v)) return v;
  if (allowRelative && v.startsWith("/") && !v.startsWith("//")) return v;
  if (allowRelative && v.startsWith("#")) return v;
  return null;
}

export function sanitizeArticleHtml(html: string): string {
  const $ = cheerio.load(html, null, false);
  $("*").each((_, node) => {
    // htmlparser2 types <script>/<style> as their own node kinds, not "tag";
    // they must still reach the drop list.
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return;
    const el = node;
    const tag = el.tagName.toLowerCase();
    const $el = $(el);
    if (DROP_WITH_CONTENT.has(tag)) {
      $el.remove();
      return;
    }
    if (tag === "h1") {
      // A body must not carry a second H1; demote rather than delete.
      $el.replaceWith(`<h2>${$el.html() ?? ""}</h2>`);
      return;
    }
    const allowed = ALLOWED[tag];
    if (!allowed) {
      $el.replaceWith($el.contents());
      return;
    }
    for (const name of Object.keys(el.attribs)) {
      if (!allowed.includes(name)) {
        $el.removeAttr(name);
        continue;
      }
      if (name === "href" || name === "src" || name === "cite") {
        const safe = safeUrl(el.attribs[name]!, name === "href");
        if (safe) $el.attr(name, safe);
        else $el.removeAttr(name);
      }
    }
    if (tag === "a") {
      const href = $el.attr("href") ?? "";
      if (/^https?:\/\//i.test(href)) $el.attr("rel", "noopener");
      else $el.removeAttr("target");
    }
    if (tag === "img" && !$el.attr("src")) $el.remove();
  });
  return $.root().html() ?? "";
}

export interface RenderedMarkdown {
  html: string;
  wordCount: number;
}

/** GFM → sanitised body HTML. Deterministic; the same markdown always yields the same bytes. */
export function renderMarkdown(md: string): RenderedMarkdown {
  const raw = marked.parse(md, { gfm: true, breaks: false, async: false });
  const html = sanitizeArticleHtml(raw).trim();
  const text = cheerio.load(html, null, false).root().text();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return { html, wordCount };
}

/** FAQ entries → an H2 + question H3s + answers, appended so the shared `faq_block` rule sees it. */
export function faqMarkdown(faq: { question: string; answer: string }[]): string {
  if (faq.length === 0) return "";
  return ["## Frequently asked questions", ...faq.map((f) => `### ${f.question.trim()}\n\n${f.answer.trim()}`)].join("\n\n");
}
