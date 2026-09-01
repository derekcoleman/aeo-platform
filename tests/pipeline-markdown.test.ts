import { describe, expect, it } from "vitest";
import { faqMarkdown, markerKeys, renderMarkdown, resolveMarkers, sanitizeArticleHtml, stripLeadingH1 } from "@/lib/pipeline/markdown";
import { gartnerSource } from "./fixtures/pipeline";

describe("resolveMarkers", () => {
  it("turns {{src:key}} into a numbered superscript link, numbering by first citation", () => {
    const second = { ...gartnerSource, key: "okta-2025", url: "https://example.org/okta", publisher: "Okta" };
    const md = "A claim {{src:gartner-2026}}. Another {{src:okta-2025}} and again {{src:gartner-2026}}.";
    const r = resolveMarkers(md, [second, gartnerSource]);
    expect(r.markdown).toBe(
      'A claim [<sup>1</sup>](https://example.org/reports/identity-2026 "Gartner"). Another [<sup>2</sup>](https://example.org/okta "Okta") and again [<sup>1</sup>](https://example.org/reports/identity-2026 "Gartner").',
    );
    expect(r.cited.map((c) => c.key)).toEqual(["gartner-2026", "okta-2025"]);
    expect(r.unresolved).toEqual([]);
  });

  it("reports markers with no matching source and removes them from the text", () => {
    const r = resolveMarkers("Number 40% {{src:made-up}} here .", [gartnerSource]);
    expect(r.unresolved).toEqual(["made-up"]);
    expect(r.cited).toEqual([]);
    expect(r.markdown).toBe("Number 40% here.");
  });

  it("markerKeys dedupes", () => {
    expect(markerKeys("{{src:a1}} {{ src:b2 }} {{src:a1}}")).toEqual(["a1", "b2"]);
  });
});

describe("sanitizeArticleHtml", () => {
  it("drops executable content and unsafe urls, keeps text", () => {
    const html = sanitizeArticleHtml('<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:alert(1)">bad</a> <a href="https://example.org/x" target="_blank">ok</a></p><style>p{}</style>');
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<a>bad</a>");
    expect(html).toContain('href="https://example.org/x"');
    expect(html).toContain('rel="noopener"');
  });

  it("demotes a stray H1 and unwraps unknown elements", () => {
    expect(sanitizeArticleHtml("<h1>Title</h1><section><p>Body</p></section>")).toBe("<h2>Title</h2><p>Body</p>");
  });

  it("keeps tables, sup and code; drops images without src", () => {
    const html = sanitizeArticleHtml('<table><tr><th scope="col">A</th><td>1<sup>2</sup></td></tr></table><img alt="x"><pre><code>x</code></pre>');
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain("<sup>2</sup>");
    expect(html).not.toContain("<img");
    expect(html).toContain("<pre><code>x</code></pre>");
  });
});

describe("renderMarkdown", () => {
  it("renders GFM tables and counts words", () => {
    const { html, wordCount } = renderMarkdown("Intro text here.\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(wordCount).toBe(7);
  });

  it("is deterministic", () => {
    const md = "## Q?\n\nAnswer [x](https://example.org/x).";
    expect(renderMarkdown(md)).toEqual(renderMarkdown(md));
  });
});

describe("helpers", () => {
  it("stripLeadingH1 removes only a leading H1", () => {
    expect(stripLeadingH1("# Title\n\nBody\n\n# Not first")).toBe("Body\n\n# Not first");
    expect(stripLeadingH1("Body")).toBe("Body");
  });

  it("faqMarkdown builds an H2 + H3 block, empty for no entries", () => {
    expect(faqMarkdown([])).toBe("");
    expect(faqMarkdown([{ question: " Q? ", answer: " A. " }])).toBe("## Frequently asked questions\n\n### Q?\n\nA.");
  });
});
