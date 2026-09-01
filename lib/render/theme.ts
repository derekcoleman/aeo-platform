/**
 * Per-tenant theming, as data.
 *
 * No per-tenant code, no per-tenant build, and no tenant-supplied JavaScript.
 * A theme is a token map plus optional sanitised HTML fragments, rendered into
 * an inline <style> block on every article.
 *
 * Inlining rather than linking a stylesheet is deliberate. The customer's
 * rewrite only covers their content prefix, so our CSS would have to come from
 * a cross-origin CDN — which a strict `style-src 'self'` CSP, a corporate
 * proxy, or an ad blocker can break. An inline block also means the page is a
 * self-contained document: AI crawlers overwhelmingly fetch raw HTML without
 * executing JS, so everything that matters is present in the first byte.
 */

export interface ThemeTokens {
  [token: string]: string | undefined;
}

export interface SiteTheme {
  tokens: ThemeTokens;
  headerHtml?: string | null;
  footerHtml?: string | null;
  customCss?: string | null;
}

/**
 * Conservative defaults. A site with no extracted theme still renders as a
 * clean, readable document rather than unstyled HTML.
 */
export const DEFAULT_TOKENS: ThemeTokens = {
  "font-sans": "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  "font-serif": "Georgia, 'Times New Roman', serif",
  "text-base": "1.0625rem",
  "line-height": "1.7",
  "measure": "68ch",
  "container": "44rem",
  "bg": "#ffffff",
  "fg": "#18181b",
  "muted": "#52525b",
  "link": "#2563eb",
  "accent": "#2563eb",
  "border": "#e4e4e7",
  "code-bg": "#f4f4f5",
  "radius": "6px",
  // Dark variants, applied under prefers-color-scheme.
  "bg-dark": "#0b0b0d",
  "fg-dark": "#ededf0",
  "muted-dark": "#a1a1aa",
  "link-dark": "#7aa7ff",
  "border-dark": "#27272a",
  "code-bg-dark": "#18181b",
};

/** Token values land inside a CSS declaration, so they must not escape it. */
const UNSAFE_TOKEN_VALUE = /[<>{};@]|\/\*|\*\/|expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i;

export function sanitiseTokenValue(value: string): string | null {
  const v = value.trim();
  if (!v || v.length > 200 || UNSAFE_TOKEN_VALUE.test(v)) return null;
  return v;
}

const TOKEN_NAME = /^[a-z0-9-]+$/;

export function tokensToCssVariables(tokens: ThemeTokens): string {
  const merged = { ...DEFAULT_TOKENS, ...tokens };
  const light: string[] = [];
  const dark: string[] = [];

  for (const [name, raw] of Object.entries(merged)) {
    if (raw == null || !TOKEN_NAME.test(name)) continue;
    const value = sanitiseTokenValue(raw);
    if (value === null) continue;

    if (name.endsWith("-dark")) {
      dark.push(`--aeo-${name.slice(0, -"-dark".length)}:${value}`);
    } else {
      light.push(`--aeo-${name}:${value}`);
    }
  }

  // Light is defined on bare :root so a theme is never left with a colour whose
  // only definition sits inside a media query.
  let css = `:root{${light.join(";")}}`;
  if (dark.length) {
    css += `@media (prefers-color-scheme:dark){:root{${dark.join(";")}}}`;
  }
  return css;
}

/**
 * The article layout. Intentionally small and boring: an article page is text,
 * and every byte here ships on every page.
 */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--aeo-bg);color:var(--aeo-fg);
  font-family:var(--aeo-font-sans);font-size:var(--aeo-text-base);
  line-height:var(--aeo-line-height);-webkit-font-smoothing:antialiased}
.aeo-wrap{max-width:var(--aeo-container);margin:0 auto;padding:2.5rem 1.25rem 4rem}
.aeo-article{max-width:var(--aeo-measure)}
.aeo-article h1{font-size:2.1rem;line-height:1.2;margin:0 0 .75rem;letter-spacing:-.02em}
.aeo-article h2{font-size:1.4rem;line-height:1.3;margin:2.5rem 0 .75rem;letter-spacing:-.01em}
.aeo-article h3{font-size:1.15rem;margin:2rem 0 .5rem}
.aeo-article p{margin:0 0 1.15rem}
.aeo-article a{color:var(--aeo-link);text-underline-offset:2px}
.aeo-article ul,.aeo-article ol{margin:0 0 1.15rem;padding-left:1.4rem}
.aeo-article li{margin:.4rem 0}
.aeo-article img{max-width:100%;height:auto;border-radius:var(--aeo-radius)}
.aeo-article blockquote{margin:1.5rem 0;padding:.25rem 0 .25rem 1rem;
  border-left:3px solid var(--aeo-border);color:var(--aeo-muted)}
.aeo-article code{background:var(--aeo-code-bg);padding:.15em .35em;
  border-radius:4px;font-size:.9em}
.aeo-article pre{background:var(--aeo-code-bg);padding:1rem;border-radius:var(--aeo-radius);
  overflow-x:auto}
.aeo-article pre code{background:none;padding:0}
/* Wide content scrolls inside its own box; the page body never scrolls sideways. */
.aeo-table-wrap{overflow-x:auto;margin:0 0 1.15rem}
.aeo-article table{border-collapse:collapse;width:100%;font-size:.95em}
.aeo-article th,.aeo-article td{border:1px solid var(--aeo-border);padding:.5rem .65rem;text-align:left}
.aeo-article th{background:var(--aeo-code-bg);font-weight:600}
.aeo-meta{color:var(--aeo-muted);font-size:.9rem;margin:0 0 2rem}
.aeo-faq{margin:2.5rem 0 0;border-top:1px solid var(--aeo-border);padding-top:1.5rem}
.aeo-faq h2{margin-top:0}
.aeo-faq dt{font-weight:600;margin:1.25rem 0 .35rem}
.aeo-faq dd{margin:0;color:var(--aeo-fg)}
`.replace(/\n\s*/g, "");

/** Full <style> contents for a page: tokens, layout, then tenant overrides. */
export function renderThemeCss(theme: SiteTheme): string {
  const custom = theme.customCss ? sanitiseCustomCss(theme.customCss) : "";
  return `${tokensToCssVariables(theme.tokens)}${BASE_CSS}${custom}`;
}

/**
 * Tenant CSS is ops-authored, but still treated as untrusted: it is the one
 * place a theme can reach outside the token vocabulary.
 */
export function sanitiseCustomCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, "")
    .replace(/<\/?(script|style)[^>]*>/gi, "");
}
