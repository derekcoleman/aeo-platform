import type { SiteRoute } from "@/lib/tenancy/types";
import { ANY_MARKER_RE, factMarkerKeys, faqMarkdown, renderMarkdown, resolveMarkers, stripFactMarkers, stripLeadingH1 } from "./markdown";
import { buildPublishedPage, type BuiltPage, type PublishInputs } from "./publish";
import type { BriefSpec, DraftOutput, SourceSpec } from "./types";
import type { AuthorRow } from "./versions";

/**
 * Draft output → the bytes a version stores and a page publishes. Pure, so
 * the draft step (for QA) and the publish step (for the real thing) compose
 * the same way and cannot drift: markdown with markers is the source of
 * truth, HTML is derived once, the page is built from both.
 */

export interface ComposeInput {
  draft: DraftOutput;
  brief: Pick<BriefSpec, "sources" | "intent">;
  site: SiteRoute;
  organization: PublishInputs["organization"];
  author: AuthorRow | null;
  slug: string;
  datePublished: Date;
  dateModified?: Date;
}

export interface Composed {
  /** Body + FAQ markdown with `{{src:key}}` markers intact (what the version stores). */
  bodyMd: string;
  /** Markers resolved to links, then rendered and sanitised. */
  bodyHtml: string;
  wordCount: number;
  /** Sources actually cited, first-citation order. */
  cited: SourceSpec[];
  unresolved: string[];
  /** `{{fact:key}}` keys the body cites, first-citation order. */
  factKeys: string[];
  /** FAQ with markers stripped — JSON-LD text, not prose with footnotes. */
  faq: { question: string; answer: string }[];
  page: BuiltPage;
}

export function stripMarkers(text: string): string {
  return text.replace(ANY_MARKER_RE, "").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

export function composeVersion(input: ComposeInput): Composed {
  const body = stripLeadingH1(input.draft.bodyMd).trim();
  const bodyMd = [body, faqMarkdown(input.draft.faq)].filter(Boolean).join("\n\n");
  const resolved = resolveMarkers(stripFactMarkers(bodyMd), input.brief.sources);
  const { html, wordCount } = renderMarkdown(resolved.markdown);
  const faq = input.draft.faq.map((f) => ({ question: f.question.trim(), answer: stripMarkers(f.answer) }));
  const page = buildPublishedPage({
    site: input.site,
    organization: input.organization,
    slug: input.slug,
    title: input.draft.title,
    description: input.draft.description,
    bodyHtml: html,
    bodyMd: resolved.markdown,
    author: input.author,
    citations: resolved.cited.map((c) => ({ url: c.url, publisher: c.publisher ?? null, title: c.title ?? null })),
    faq,
    datePublished: input.datePublished,
    dateModified: input.dateModified,
  });
  return { bodyMd, bodyHtml: html, wordCount, cited: resolved.cited, unresolved: resolved.unresolved, factKeys: factMarkerKeys(bodyMd), faq, page };
}
