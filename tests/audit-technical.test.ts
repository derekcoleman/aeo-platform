import { describe, expect, it } from "vitest";
import { parseHtml } from "@/lib/audit/html";
import { analyzeUrlStructure, checkSecurityHeaders, detectFramework, isNoindex, parseMetaTags } from "@/lib/audit/technical";

const LONG = "Real server-rendered content. ".repeat(20);

describe("detectFramework", () => {
  it("recognises Next.js with server-rendered content", () => {
    const html = `<html><body><div id="__next"><p>${LONG}</p></div><script src="/_next/static/x.js"></script></body></html>`;
    expect(detectFramework(html, parseHtml(html))).toEqual({ ssr: true, framework: "next.js" });
  });
  it("calls an empty mount node a client-only SPA", () => {
    const html = `<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
    const r = detectFramework(html, parseHtml(html));
    expect(r.ssr).toBe(false);
    expect(r.framework).toBe("spa");
  });
  it("labels unknown frameworks with content as ssr", () => {
    const html = `<html><body><article>${LONG}</article></body></html>`;
    expect(detectFramework(html, parseHtml(html))).toEqual({ ssr: true, framework: "ssr" });
  });
});

describe("parseMetaTags", () => {
  it("finds tags across name/property/canonical variants", () => {
    const $ = parseHtml(`<html><head>
      <title>T</title>
      <meta name="description" content="d">
      <meta property="og:title" content="o">
      <link rel="canonical" href="https://a.com/">
      <meta name="viewport" content="width=device-width">
    </head></html>`);
    const m = parseMetaTags($);
    expect(m.present).toEqual(expect.arrayContaining(["title", "description", "og:title", "canonical", "viewport"]));
    expect(m.missing).not.toContain("title");
    expect(m.details.canonical).toBe("https://a.com/");
  });
});

describe("checkSecurityHeaders / isNoindex / url structure", () => {
  it("splits present and missing security headers", () => {
    const r = checkSecurityHeaders(new Headers({ "strict-transport-security": "max-age=1", "x-content-type-options": "nosniff" }));
    expect(r.present).toEqual(expect.arrayContaining(["strict-transport-security", "x-content-type-options"]));
    expect(r.missing.length).toBeGreaterThan(0);
  });
  it("reads noindex from meta or header", () => {
    expect(isNoindex(parseHtml('<meta name="robots" content="noindex,follow">'), new Headers())).toBe(true);
    expect(isNoindex(parseHtml("<p>x</p>"), new Headers({ "x-robots-tag": "noindex" }))).toBe(true);
    expect(isNoindex(parseHtml("<p>x</p>"), new Headers())).toBe(false);
  });
  it("classifies url structure", () => {
    expect(analyzeUrlStructure(["https://a.com/x", "https://a.com/y/z"])).toBe("clean");
    expect(analyzeUrlStructure(["https://a.com/?p=1", "https://a.com/?p=2", "https://a.com/?p=3"])).toBe("parameterized");
  });
});
