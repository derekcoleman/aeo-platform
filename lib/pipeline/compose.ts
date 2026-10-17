import { renderArticleDocument } from "@/lib/render/document";
import type { PublishedPage } from "@/lib/render/published";
import type { SiteRenderConfig } from "@/lib/render/site-config";
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
  /**
   * The body already ends in its FAQ section: a stored version's markdown,
   * recomposed at publish. Appending `draft.faq` again would print it twice.
   */
  faqIncluded?: boolean;
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
  const bodyMd = input.faqIncluded ? body : [body, faqMarkdown(input.draft.faq)].filter(Boolean).join("\n\n");
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

/**
 * The full article document as the renderer would serve it on the canonical
 * host (head, JSON-LD, H1, byline, dates), for QA. Scoring the body alone
 * misses everything the document layer adds, so a draft could fail the
 * structure floor on rules the published page passes. The theme is left at
 * its defaults: QA scores structure, not styling.
 */
export function composeQaDocument(composed: Pick<Composed, "page">, site: SiteRoute, organization: PublishInputs["organization"], slug: string): string {
  const config: SiteRenderConfig = {
    siteId: site.id,
    canonicalDomain: site.canonicalDomain,
    pathPrefix: site.pathPrefix,
    locale: site.locale,
    trailingSlash: site.trailingSlash,
    theme: { tokens: {} },
    organization,
    indexingPaused: false,
  };
  const page: PublishedPage = {
    siteId: site.id,
    path: composed.page.path,
    contentItemId: null,
    status: "live",
    html: composed.page.html,
    head: composed.page.head,
    markdown: composed.page.markdown,
    etag: composed.page.etag,
    updatedAt: new Date(composed.page.head.dateModified ?? 0),
  };
  return renderArticleDocument({ config, host: { canonicalDomain: site.canonicalDomain, indexable: true }, page, slug });
}

/**
 * What the structure gate scores for an item. A proxy page is the document
 * the renderer serves. A cms item ships only its body HTML and FAQ into the
 * customer's CMS template: none of our head, JSON-LD, byline or canonical go
 * with it, and its slug here is internal, so it is scored as a body.
 */
export function qaDocumentFor(
  composed: Pick<Composed, "page">,
  origin: "pipeline" | "cms",
  site: SiteRoute,
  organization: PublishInputs["organization"],
  slug: string,
): { documentHtml?: string; canonicalUrl?: string } {
  if (origin === "cms") return {};
  return { documentHtml: composeQaDocument(composed, site, organization, slug), canonicalUrl: composed.page.canonicalUrl };
}
