import { absoluteUrl, contentUrl, type PublicHostResolution } from "@/lib/tenancy";
import { escapeHtml, sanitizeFragment, serializeJsonLd } from "./sanitize";
import { renderThemeCss } from "./theme";
import type { PublishedPage } from "./published";
import type { SiteRenderConfig } from "./site-config";

/**
 * Build a published article as a complete HTML document.
 *
 * This is deliberately string composition rather than a React page. An App
 * Router page injects the Next client runtime into every response, and this
 * page's entire value proposition is that it does not need JavaScript:
 *
 *  - AI crawlers overwhelmingly fetch raw HTML without executing JS, so the
 *    content has to be complete in the first byte.
 *  - A strict `style-src 'self'` CSP or a blocked CDN on the customer's edge
 *    must not be able to leave their readers an unstyled page on their own
 *    domain, so CSS is inlined and nothing is fetched cross-origin.
 *  - LCP is one round trip, on someone else's Core Web Vitals.
 *
 * Composing the bytes here also means the edge-hostname assertion runs over
 * exactly what we send, not over an approximation of it.
 */
export interface DocumentInput {
  config: SiteRenderConfig;
  host: PublicHostResolution;
  page: PublishedPage;
  slug: string;
}

export function renderArticleDocument({ config, host, page, slug }: DocumentInput): string {
  const head = page.head;
  const canonical = contentUrl(host, config, slug);
  const indexable = host.indexable && !head.noindex;
  const title = head.title ?? slug;

  const meta: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    // Agent fetchers increasingly prefer markdown, and advertising it costs a tag.
    `<link rel="alternate" type="text/markdown" href="${escapeHtml(`${canonical}.md`)}">`,
    `<link rel="alternate" type="application/atom+xml" href="${escapeHtml(
      absoluteUrl(host, `${config.pathPrefix}/feed.xml`),
    )}">`,
  ];

  if (head.description) {
    meta.push(`<meta name="description" content="${escapeHtml(head.description)}">`);
  }
  if (!indexable) {
    // We could not verify which public host this arrived on. Serving it
    // indexable would publish a duplicate of the customer's content under a
    // host they may not control.
    meta.push('<meta name="robots" content="noindex,nofollow">');
  }

  meta.push(
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
  );
  if (head.description) {
    meta.push(`<meta property="og:description" content="${escapeHtml(head.description)}">`);
  }
  if (head.image) {
    meta.push(
      `<meta property="og:image" content="${escapeHtml(head.image)}">`,
      '<meta name="twitter:card" content="summary_large_image">',
    );
  }
  if (head.datePublished) {
    meta.push(
      `<meta property="article:published_time" content="${escapeHtml(head.datePublished)}">`,
    );
  }
  if (head.dateModified) {
    meta.push(`<meta property="article:modified_time" content="${escapeHtml(head.dateModified)}">`);
  }

  const jsonLd = head.jsonLd
    ? `<script type="application/ld+json">${serializeJsonLd(head.jsonLd)}</script>`
    : "";

  const headerHtml = sanitizeFragment(config.theme.headerHtml);
  const footerHtml = sanitizeFragment(config.theme.footerHtml);

  return (
    `<!doctype html><html lang="${escapeHtml(config.locale)}"><head>` +
    meta.join("") +
    `<style>${renderThemeCss(config.theme)}</style>` +
    jsonLd +
    `</head><body>` +
    headerHtml +
    `<div class="aeo-wrap"><article class="aeo-article">` +
    // The document owns the h1 and byline; published_pages.html is the body
    // only. That keeps heading order correct and means the title, the <title>
    // tag and the JSON-LD headline all come from one column rather than three.
    `<h1>${escapeHtml(title)}</h1>` +
    renderByline(head) +
    page.html +
    `</article></div>` +
    footerHtml +
    `</body></html>`
  );
}

/**
 * A real named author with a visible last-updated date. Both are E-E-A-T
 * signals, and both are part of the argument that this is first-party content
 * the customer stands behind rather than vendor output on their subfolder.
 */
function renderByline(head: PublishedPage["head"]): string {
  const bits: string[] = [];
  if (head.author?.name) {
    const name = escapeHtml(head.author.name);
    bits.push(
      head.author.url ? `By <a href="${escapeHtml(head.author.url)}">${name}</a>` : `By ${name}`,
    );
  }
  const shown = head.dateModified ?? head.datePublished;
  if (shown) {
    const label = head.dateModified && head.dateModified !== head.datePublished ? "Updated" : "Published";
    bits.push(`${label} <time datetime="${escapeHtml(shown)}">${escapeHtml(shown.slice(0, 10))}</time>`);
  }
  return bits.length ? `<p class="aeo-meta">${bits.join(" · ")}</p>` : "";
}

/** The `.md` variant advertised by `rel="alternate"` and by llms.txt. */
export function renderArticleMarkdown({ config, host, page, slug }: DocumentInput): string {
  const url = contentUrl(host, config, slug);
  const front = [
    "---",
    `title: ${JSON.stringify(page.head.title ?? slug)}`,
    `url: ${url}`,
    ...(page.head.datePublished ? [`date_published: ${page.head.datePublished}`] : []),
    ...(page.head.dateModified ? [`date_modified: ${page.head.dateModified}`] : []),
    ...(page.head.author?.name ? [`author: ${JSON.stringify(page.head.author.name)}`] : []),
    "---",
    "",
  ].join("\n");
  return front + (page.markdown ?? "");
}
