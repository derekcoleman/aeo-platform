import type { PublicHostResolution } from "@/lib/tenancy";
import { absoluteUrl } from "@/lib/tenancy";
import type { PageHead } from "./published";
import type { SiteRenderConfig } from "./site-config";

export interface PageSummary {
  path: string;
  head: PageHead;
  updatedAt: Date;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSitemap(host: PublicHostResolution, pages: PageSummary[]): string {
  const urls = pages
    .map(
      (p) =>
        `<url><loc>${xmlEscape(absoluteUrl(host, p.path))}</loc>` +
        `<lastmod>${p.updatedAt.toISOString()}</lastmod></url>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

export function buildFeed(
  host: PublicHostResolution,
  config: SiteRenderConfig,
  pages: PageSummary[],
): string {
  const title = config.organization.name ?? config.canonicalDomain;
  const self = absoluteUrl(host, `${config.pathPrefix}/feed.xml`);
  const items = pages
    .slice(0, 50)
    .map((p) => {
      const url = absoluteUrl(host, p.path);
      return (
        `<entry><title>${xmlEscape(p.head.title ?? p.path)}</title>` +
        `<link href="${xmlEscape(url)}"/><id>${xmlEscape(url)}</id>` +
        `<updated>${p.updatedAt.toISOString()}</updated>` +
        (p.head.description ? `<summary>${xmlEscape(p.head.description)}</summary>` : "") +
        `</entry>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<title>${xmlEscape(title)}</title><link rel="self" href="${xmlEscape(self)}"/>` +
    `<id>${xmlEscape(absoluteUrl(host, config.pathPrefix))}</id>` +
    `<updated>${(pages[0]?.updatedAt ?? new Date()).toISOString()}</updated>${items}</feed>`
  );
}

/**
 * llms.txt — a curated markdown index for answer engines and agent fetchers.
 *
 * Kept to titles, one-line descriptions and links rather than full text; that
 * is what llms-full.txt is for, and an index that is mostly prose stops being
 * an index.
 */
export function buildLlmsTxt(
  host: PublicHostResolution,
  config: SiteRenderConfig,
  pages: PageSummary[],
): string {
  const org = config.organization;
  const lines: string[] = [`# ${org.name ?? config.canonicalDomain}`, ""];

  if (org.url) lines.push(`> ${org.url}`, "");
  lines.push(
    "## Articles",
    "",
    ...pages.map((p) => {
      const url = absoluteUrl(host, p.path);
      const desc = p.head.description ? `: ${p.head.description}` : "";
      return `- [${p.head.title ?? p.path}](${url})${desc}`;
    }),
    "",
    "## Machine-readable",
    "",
    `- [Sitemap](${absoluteUrl(host, `${config.pathPrefix}/sitemap.xml`)})`,
    `- [Full text](${absoluteUrl(host, "/llms-full.txt")})`,
    `- [Atom feed](${absoluteUrl(host, `${config.pathPrefix}/feed.xml`)})`,
    "",
    "Every article is also available as Markdown by appending `.md` to its URL.",
    "",
  );
  return lines.join("\n");
}

/** Soft cap so a large corpus paginates rather than producing a 20MB response. */
export const LLMS_FULL_MAX_BYTES = 2_000_000;

export function buildLlmsFullTxt(
  host: PublicHostResolution,
  config: SiteRenderConfig,
  pages: (PageSummary & { markdown: string | null })[],
): { body: string; truncated: boolean } {
  const header = `# ${config.organization.name ?? config.canonicalDomain} — full text\n`;
  const parts: string[] = [header];
  let size = header.length;
  let truncated = false;

  for (const p of pages) {
    if (!p.markdown) continue;
    const block = `\n\n---\n\n# ${p.head.title ?? p.path}\nURL: ${absoluteUrl(host, p.path)}\n\n${p.markdown}`;
    if (size + block.length > LLMS_FULL_MAX_BYTES) {
      truncated = true;
      break;
    }
    parts.push(block);
    size += block.length;
  }
  return { body: parts.join(""), truncated };
}
