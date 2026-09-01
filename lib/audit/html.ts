import * as cheerio from "cheerio";
import TurndownService from "turndown";

/** Shared HTML helpers for the audit modules. One parse per page, reused. */

export type Doc = cheerio.CheerioAPI;

export function parseHtml(html: string): Doc {
  return cheerio.load(html);
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "nav", "footer", "iframe", "noscript", "form", "button", "aside"]);
turndown.remove((node) => node.nodeName.toLowerCase() === "svg");

export function htmlToMarkdown(html: string, maxChars = Infinity): string {
  let md: string;
  try {
    md = turndown.turndown(html);
  } catch {
    md = "";
  }
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  return md.length > maxChars ? md.slice(0, maxChars) : md;
}

export function pageTitle($: Doc): string {
  return ($("title").first().text() || $("h1").first().text() || "").trim();
}

export function visibleText($: Doc): string {
  const clone = $("body").clone();
  clone.find("script, style, noscript, template").remove();
  return clone.text().replace(/\s+/g, " ").trim();
}

/**
 * Same-origin links from the DOM (not from comments or scripts, which the old
 * href regex happily picked up). Returns absolute URLs, deduped, fragment-free.
 */
export function internalLinks($: Doc, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    if (u.hostname !== base.hostname) return;
    if (ASSET_RE.test(u.pathname)) return;
    u.hash = "";
    const key = u.href.replace(/\/$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u.href);
  });
  return out;
}

export const ASSET_RE = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|pdf|zip|mp4|mp3|xml|json|txt)$/i;

/** Sitemap `<loc>` extraction; handles sitemap indexes one level deep (caller fetches children). */
export function sitemapLocs(xml: string): { urls: string[]; children: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const children: string[] = [];
  const urls: string[] = [];
  $("sitemapindex > sitemap > loc").each((_, el) => {
    children.push($(el).text().trim());
  });
  $("urlset > url > loc").each((_, el) => {
    urls.push($(el).text().trim());
  });
  if (urls.length === 0 && children.length === 0) {
    // Lenient fallback for namespaced or slightly broken sitemaps.
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) urls.push(m[1]!);
  }
  return { urls: urls.filter(Boolean), children: children.filter(Boolean) };
}
