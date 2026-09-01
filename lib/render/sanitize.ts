/**
 * Sanitiser for tenant theme fragments (header/footer markup captured from the
 * customer's own site so our pages match their chrome).
 *
 * These fragments are authored by our ops team rather than end customers, but
 * they are still scraped from a third-party site and injected into a page
 * served on the customer's own origin. A script that got through here would run
 * same-origin with their production application.
 *
 * Deliberately an allowlist: unknown tags and attributes are dropped, not
 * inspected. A denylist is the wrong shape for this problem.
 */

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "br", "button", "div", "em", "footer", "h1", "h2", "h3", "h4",
  "header", "hr", "i", "img", "li", "nav", "ol", "p", "picture", "small", "source",
  "span", "strong", "sub", "sup", "svg", "path", "circle", "rect", "g", "ul",
]);

const ALLOWED_ATTRS = new Set([
  "alt", "aria-hidden", "aria-label", "class", "d", "fill", "height", "href",
  "id", "loading", "role", "src", "srcset", "stroke", "stroke-width", "title",
  "viewbox", "width", "xmlns", "cx", "cy", "r", "x", "y", "rx", "points",
  "fill-rule", "clip-rule", "stroke-linecap", "stroke-linejoin",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "source", "path", "circle", "rect"]);

/** `javascript:`, `data:` (except images), and `vbscript:` are all rejected. */
function safeUrl(value: string): string | null {
  const v = value.trim();
  if (/^(javascript|vbscript|file):/i.test(v)) return null;
  if (/^data:/i.test(v) && !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(v)) return null;
  return v;
}

export function sanitizeFragment(html: string | null | undefined): string {
  if (!html) return "";

  // Strip whole dangerous elements including their contents first, so removing
  // only the tags cannot leave executable text behind.
  let out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript|base|link|meta)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript|base|link|meta)\b[^>]*\/?>/gi, "");

  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (match, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (match.startsWith("</")) return `</${tag}>`;

    const attrs: string[] = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(rawAttrs)) !== null) {
      const name = m[1]!.toLowerCase();
      // Every on* handler, and anything not explicitly allowed, is dropped.
      if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) continue;

      let value = m[3] ?? m[4] ?? m[5] ?? "";
      if (name === "href" || name === "src" || name === "srcset") {
        const safe = safeUrl(value);
        if (safe === null) continue;
        value = safe;
      }
      attrs.push(`${name}="${escapeAttr(value)}"`);
    }

    // Links out of a customer's own chrome should not be able to reach back
    // into our page via window.opener.
    if (tag === "a" && attrs.some((a) => a.startsWith('href="http'))) {
      attrs.push('rel="noopener"');
    }

    const body = attrs.length ? `${tag} ${attrs.join(" ")}` : tag;
    return VOID_TAGS.has(tag) ? `<${body}>` : `<${body}>`;
  });

  return out;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * JSON-LD is injected inside a <script> element, where normal HTML escaping
 * does not apply but `</script` and comment-open sequences still terminate the
 * block. Escaping the `<` is the standard safe form.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
