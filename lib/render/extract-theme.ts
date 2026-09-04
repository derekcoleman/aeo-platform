import * as cheerio from "cheerio";
import { sanitizeFragment } from "./sanitize";
import { sanitiseTokenValue, type SiteTheme, type ThemeTokens } from "./theme";

/**
 * A first-pass theme from a customer's homepage HTML: fonts, colours, radius
 * and the header/footer fragments, derived from inline styles, <style>
 * blocks and meta tags. No JavaScript is executed and no external stylesheet
 * is fetched, so this is deliberately conservative; ops refines it in the
 * editor, and the Playwright extraction on the worker plane replaces it when
 * that ships. Everything that lands in the theme goes through the same
 * sanitisers the renderer applies.
 */

export interface ThemeExtraction {
  theme: SiteTheme;
  evidence: string[];
  logo: string | null;
}

const HEX = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi;
const FONT_FAMILY = /font-family\s*:\s*([^;}"']+)/gi;
const RADIUS = /border-radius\s*:\s*(\d+(?:\.\d+)?(?:px|rem|em))/gi;
const GENERIC_FONTS = new Set(["inherit", "initial", "unset", "sans-serif", "serif", "monospace", "system-ui"]);

function mostCommon<T>(values: T[], skip: (v: T) => boolean = () => false): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (!skip(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function normaliseHex(h: string): string {
  const s = h.toLowerCase();
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function absolute(base: string, href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function extractTheme(html: string, baseUrl: string): ThemeExtraction {
  const $ = cheerio.load(html);
  const evidence: string[] = [];
  const tokens: ThemeTokens = {};
  const css = $("style").map((_, el) => $(el).text()).get().join("\n") + "\n" + $("[style]").map((_, el) => String($(el).attr("style"))).get().join(";\n");

  // Fonts: the most-declared family that is not a generic keyword.
  const families: string[] = [];
  for (const m of css.matchAll(FONT_FAMILY)) {
    const first = m[1]!.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
    if (first && !GENERIC_FONTS.has(first.toLowerCase()) && !first.startsWith("var(")) families.push(first);
  }
  const bodyFont = mostCommon(families);
  if (bodyFont) {
    const stack = `'${bodyFont}', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
    if (sanitiseTokenValue(stack)) {
      tokens["font-sans"] = stack;
      evidence.push(`font-family '${bodyFont}' declared ${families.filter((f) => f === bodyFont).length}×`);
    }
  }

  // Accent: theme-color meta first, then the most common saturated colour in CSS.
  const themeColor = $('meta[name="theme-color"]').attr("content");
  const colors = [...css.matchAll(HEX)].map((m) => normaliseHex(m[0]));
  const accent = themeColor && /^#[0-9a-f]{3,6}$/i.test(themeColor.trim()) ? normaliseHex(themeColor.trim()) : mostCommon(colors, (c) => luminance(c) > 0.85 || luminance(c) < 0.08);
  if (accent) {
    tokens.accent = accent;
    tokens.link = accent;
    evidence.push(themeColor ? `theme-color meta ${accent}` : `most common mid-luminance colour ${accent}`);
  }
  const bg = mostCommon(colors, (c) => luminance(c) <= 0.85);
  if (bg && bg !== "#ffffff") {
    tokens.bg = bg;
    evidence.push(`light background ${bg}`);
  }
  const fg = mostCommon(colors, (c) => luminance(c) >= 0.25);
  if (fg) {
    tokens.fg = fg;
    evidence.push(`dark text colour ${fg}`);
  }
  const radius = mostCommon([...css.matchAll(RADIUS)].map((m) => m[1]!));
  if (radius) {
    tokens.radius = radius;
    evidence.push(`border-radius ${radius}`);
  }

  // Header and footer fragments, sanitised with the renderer's allowlist.
  const headerEl = $("header").first().length ? $("header").first() : $('[role="banner"]').first();
  const footerEl = $("footer").first().length ? $("footer").first() : $('[role="contentinfo"]').first();
  const headerHtml = headerEl.length ? sanitizeFragment($.html(headerEl)) : null;
  const footerHtml = footerEl.length ? sanitizeFragment($.html(footerEl)) : null;
  if (headerHtml) evidence.push(`header fragment ${headerHtml.length} chars`);
  if (footerHtml) evidence.push(`footer fragment ${footerHtml.length} chars`);

  const logo =
    absolute(baseUrl, $('meta[property="og:logo"]').attr("content")) ??
    absolute(baseUrl, $('link[rel="apple-touch-icon"]').attr("href")) ??
    absolute(baseUrl, $('link[rel~="icon"]').attr("href")) ??
    absolute(baseUrl, $("header img").first().attr("src"));

  return { theme: { tokens, headerHtml, footerHtml, customCss: null }, evidence, logo };
}
