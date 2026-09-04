import { describe, expect, it } from "vitest";
import { extractTheme } from "@/lib/render/extract-theme";

const HTML = `<!doctype html><html><head>
<meta name="theme-color" content="#0055FF">
<link rel="icon" href="/favicon.png">
<style>
  body { font-family: "Inter", system-ui, sans-serif; color: #1a1a1a; background: #ffffff; }
  h1 { font-family: Inter, sans-serif; }
  .btn { background: #0055ff; border-radius: 8px; color: #fff; }
  .card { border-radius: 8px; border: 1px solid #e5e5e5; }
  a { color: #0055ff; }
</style></head>
<body>
<header class="nav"><a href="/"><img src="/logo.svg" alt="Acme"></a><nav><a href="/pricing">Pricing</a><script>alert(1)</script></nav></header>
<main><h1>Acme</h1></main>
<footer><p>© Acme</p><a href="javascript:evil()">x</a></footer>
</body></html>`;

describe("extractTheme", () => {
  it("derives fonts, colours, radius and fragments from the homepage", () => {
    const out = extractTheme(HTML, "https://acme.com/");
    expect(out.theme.tokens["font-sans"]).toContain("'Inter'");
    expect(out.theme.tokens.accent).toBe("#0055ff");
    expect(out.theme.tokens.link).toBe("#0055ff");
    expect(out.theme.tokens.fg).toBe("#1a1a1a");
    expect(out.theme.tokens.radius).toBe("8px");
    expect(out.theme.headerHtml).toContain("Pricing");
    expect(out.theme.headerHtml).not.toContain("<script");
    expect(out.theme.footerHtml).toContain("© Acme");
    expect(out.theme.footerHtml).not.toContain("javascript:");
    expect(out.logo).toBe("https://acme.com/favicon.png");
    expect(out.evidence.length).toBeGreaterThan(3);
  });
  it("is quiet on a page with nothing to learn", () => {
    const out = extractTheme("<html><body><p>hi</p></body></html>", "https://x.test/");
    expect(out.theme.tokens).toEqual({});
    expect(out.theme.headerHtml).toBeNull();
    expect(out.logo).toBeNull();
  });
});
