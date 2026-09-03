import type { Doc } from "./html";
import type { SsrFramework, TechnicalResult } from "./types";

export const EXPECTED_META_TAGS = [
  "title",
  "description",
  "og:title",
  "og:description",
  "og:image",
  "twitter:card",
  "canonical",
  "viewport",
  "robots",
] as const;

export const SECURITY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
] as const;

export function detectFramework(html: string, $: Doc): { ssr: boolean; framework: SsrFramework } {
  const isNext = html.includes("__NEXT_DATA__") || html.includes("/_next/") || $('script[src*="/_next/"]').length > 0;
  const isNuxt = html.includes("__NUXT__") || html.includes("/_nuxt/");
  const isGatsby = html.includes("___gatsby") || html.includes("window.__GATSBY");
  const isAstro = $("astro-island").length > 0 || html.includes("astro-island") || $('meta[name="generator"][content*="Astro"]').length > 0;
  const isRemix = html.includes("__remixContext");
  const isSvelte = html.includes("__sveltekit");

  const bodyText = $("body").clone().find("script,style,noscript").remove().end().text().replace(/\s+/g, " ").trim();
  const hasContent = bodyText.length > 200;

  // A single empty mount node with no server-rendered content is a client-only SPA.
  const roots = $("#root, #app, #__next, #___gatsby, #__nuxt");
  const emptyRoot = roots.length > 0 && roots.toArray().every((el) => $(el).text().trim().length < 50);

  const framework: SsrFramework = isNext
    ? "next.js"
    : isNuxt
      ? "nuxt"
      : isGatsby
        ? "gatsby"
        : isAstro
          ? "astro"
          : isRemix
            ? "remix"
            : isSvelte
              ? "sveltekit"
              : hasContent
                ? "ssr"
                : emptyRoot
                  ? "spa"
                  : "unknown";

  // Framework fingerprints alone don't prove SSR — a Next app can still ship an
  // empty shell. Content on the wire is the test.
  return { ssr: hasContent && !(emptyRoot && !hasContent), framework: hasContent ? framework : emptyRoot ? "spa" : framework };
}

export function parseMetaTags($: Doc): TechnicalResult["metaTags"] {
  const details: Record<string, string> = {};
  const title = $("title").first().text().trim();
  if (title) details.title = title;
  const canonical = $('link[rel="canonical"]').attr("href");
  if (canonical) details.canonical = canonical.trim();
  const lang = $("html").attr("lang");
  if (lang) details.lang = lang;

  for (const name of ["description", "viewport", "robots", "twitter:card", "twitter:title", "twitter:description", "author"]) {
    const v = $(`meta[name="${name}"]`).attr("content") ?? $(`meta[property="${name}"]`).attr("content");
    if (v) details[name] = v.trim();
  }
  for (const prop of ["og:title", "og:description", "og:image", "og:url", "og:type", "og:site_name", "article:published_time", "article:modified_time", "article:author"]) {
    const v = $(`meta[property="${prop}"]`).attr("content") ?? $(`meta[name="${prop}"]`).attr("content");
    if (v) details[prop] = v.trim();
  }

  const present = EXPECTED_META_TAGS.filter((t) => details[t]);
  const missing = EXPECTED_META_TAGS.filter((t) => !details[t]);
  return { present, missing, details };
}

export function checkSecurityHeaders(headers: Headers): TechnicalResult["securityHeaders"] {
  const present = SECURITY_HEADERS.filter((h) => headers.has(h));
  const missing = SECURITY_HEADERS.filter((h) => !headers.has(h));
  return { present, missing };
}

export function analyzeUrlStructure(urls: string[]): TechnicalResult["urlStructure"] {
  if (urls.length === 0) return "clean";
  let param = 0;
  for (const u of urls) {
    try {
      if (new URL(u).search) param++;
    } catch {
      /* ignore */
    }
  }
  const ratio = param / urls.length;
  return ratio === 0 ? "clean" : ratio > 0.5 ? "parameterized" : "mixed";
}

export function checkCoreWebVitalsIndicators($: Doc): TechnicalResult["coreWebVitalsIndicators"] {
  const imgs = $("img").toArray();
  const unsized = imgs.filter((el) => !$(el).attr("width") || !$(el).attr("height"));
  const hasUnsizedImages = unsized.length > 0 && unsized.length / Math.max(1, imgs.length) > 0.3;

  const firstImg = imgs[0];
  const hasLargeHeroImage = !!firstImg && (() => {
    const w = Number($(firstImg).attr("width") ?? 0);
    const cls = ($(firstImg).attr("class") ?? "") + " " + ($(firstImg).parent().attr("class") ?? "");
    const lazy = ($(firstImg).attr("loading") ?? "") === "lazy";
    return w >= 1200 || /hero|banner|cover|masthead/i.test(cls) || (lazy && $(firstImg).parents("header,section").length > 0);
  })();

  const blockingStyles = $("head link[rel='stylesheet']").toArray().filter((el) => !$(el).attr("media") || $(el).attr("media") === "all").length;
  const blockingScripts = $("head script[src]").toArray().filter((el) => !$(el).attr("async") && !$(el).attr("defer") && $(el).attr("type") !== "module").length;
  const hasRenderBlockingResources = blockingStyles > 3 || blockingScripts > 0;

  const risk = (hasLargeHeroImage ? 2 : 0) + (hasRenderBlockingResources ? 2 : 0) + (hasUnsizedImages ? 1 : 0);
  return {
    hasLargeHeroImage,
    hasRenderBlockingResources,
    hasUnsizedImages,
    estimatedLcpRisk: risk >= 4 ? "high" : risk >= 2 ? "medium" : "low",
  };
}

export function isNoindex($: Doc, headers: Headers): boolean {
  const meta = ($('meta[name="robots"]').attr("content") ?? "") + " " + ($('meta[name="googlebot"]').attr("content") ?? "");
  const header = headers.get("x-robots-tag") ?? "";
  return /noindex/i.test(meta) || /noindex/i.test(header);
}

export function calculateTechnicalScore(r: Omit<TechnicalResult, "totalScore">): number {
  let score = 0;
  if (r.ssrDetected) score += 25;
  score += Math.round((r.metaTags.present.length / EXPECTED_META_TAGS.length) * 15);
  if (!r.noindex) score += 15;
  score += Math.round((r.securityHeaders.present.length / SECURITY_HEADERS.length) * 10);
  let cwv = 10;
  if (r.coreWebVitalsIndicators.hasLargeHeroImage) cwv -= 4;
  if (r.coreWebVitalsIndicators.hasRenderBlockingResources) cwv -= 3;
  if (r.coreWebVitalsIndicators.hasUnsizedImages) cwv -= 3;
  score += Math.max(0, cwv);
  if (r.mobileOptimized) score += 10;
  score += r.urlStructure === "clean" ? 5 : r.urlStructure === "mixed" ? 2 : 0;
  if (r.httpStatus >= 200 && r.httpStatus < 300) score += 5;
  if (r.httpsEnabled) score += 5;
  return Math.max(0, Math.min(100, score));
}

export interface TechnicalInput {
  html: string;
  $: Doc;
  headers: Headers;
  status: number;
  finalUrl: string;
  sampledUrls: string[];
}

export function analyzeTechnical(input: TechnicalInput): TechnicalResult {
  const { $, html, headers, status, finalUrl, sampledUrls } = input;
  const { ssr, framework } = detectFramework(html, $);
  const metaTags = parseMetaTags($);
  const viewport = metaTags.details.viewport ?? "";
  const partial: Omit<TechnicalResult, "totalScore"> = {
    ssrDetected: ssr,
    framework,
    metaTags,
    securityHeaders: checkSecurityHeaders(headers),
    mobileOptimized: /width\s*=\s*device-width/i.test(viewport),
    urlStructure: analyzeUrlStructure(sampledUrls),
    coreWebVitalsIndicators: checkCoreWebVitalsIndicators($),
    httpStatus: status,
    httpsEnabled: finalUrl.startsWith("https://"),
    noindex: isNoindex($, headers),
  };
  return { ...partial, totalScore: calculateTechnicalScore(partial) };
}
