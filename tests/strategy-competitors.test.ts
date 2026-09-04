import { describe, expect, it } from "vitest";
import { analyzeHtml, classifyContentType, structuralTargetBlock, structuralTargetFrom, type CompetitorPageRow } from "@/lib/strategy/competitors";
import { parseHtml } from "@/lib/audit/html";

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

describe("classifyContentType", () => {
  const sig = (title: string, html: string) => {
    const $ = parseHtml(html);
    const headings = $("h2, h3").map((_, el) => $(el).text()).get();
    return classifyContentType({ title, headings, markdown: $("body").text(), $ });
  };
  it("recognises comparisons, how-tos, lists, FAQs, news and product pages", () => {
    expect(sig("Okta vs Entra ID: which SSO is better?", page("x", "<table><tr><td>a</td></tr></table>"))).toBe("comparison");
    expect(sig("How to set up SCIM provisioning", page("x", "<ol><li>1</li><li>2</li><li>3</li></ol>"))).toBe("howto");
    expect(sig("12 best identity providers in 2026", page("x", "<p>list</p>"))).toBe("listicle");
    expect(sig("SCIM FAQ", page("x", ""))).toBe("faq");
    expect(sig("Acme announces SCIM support", page("x", ""))).toBe("news");
    expect(sig("Identity platform", page("x", "<p>Start free. Book a demo. Sign up today for pricing.</p>"))).toBe("product");
    expect(sig("Guide", page("x", `<p>${"word ".repeat(400)}</p>`))).toBe("guide");
  });
});

describe("analyzeHtml", () => {
  it("returns headings, word count, a structure score and a classification", () => {
    const html = page("What is SCIM provisioning?", "<p>SCIM automates account lifecycle across apps in one standard.</p><h2>What does SCIM do?</h2><p>It provisions and deprovisions users.</p><h2>How is it different from SSO?</h2><p>SSO authenticates; SCIM provisions.</p>");
    const a = analyzeHtml("https://okta.com/scim", html);
    expect(a.domain).toBe("okta.com");
    expect(a.title).toContain("SCIM");
    expect(a.headings).toHaveLength(2);
    expect(a.wordCount).toBeGreaterThan(15);
    expect(a.structure?.findings.length).toBeGreaterThan(5);
    expect(["guide", "faq", "unknown"]).toContain(a.contentType);
  });
});

describe("structuralTargetFrom", () => {
  const row = (o: Partial<CompetitorPageRow>): CompetitorPageRow => ({
    id: "x", topic_id: null, url: "https://a.com/p", domain: "a.com", title: null, content_type: "guide", word_count: 1000, structure_score: null, headings: ["What is it?", "Setup"], citations_30d: 1, last_cited_at: null, fetch_error: null, fetched_at: null, ...o,
  });
  it("summarises the dominant format, medians and feature shares, skipping failed fetches", () => {
    const rows = [
      row({ content_type: "comparison", word_count: 1500, structure_score: { score: 50, maxScore: 100, normalized: 50, findings: [{ key: "comparison_table", title: "", passed: true, score: 1, maxScore: 1, evidence: {} }] } }),
      row({ url: "https://b.com/p", content_type: "comparison", word_count: 900 }),
      row({ url: "https://c.com/p", content_type: "guide", word_count: 2200, headings: ["Why?", "How?"] }),
      row({ url: "https://d.com/p", fetch_error: "status 403", word_count: 0 }),
    ];
    const t = structuralTargetFrom(rows);
    expect(t.pages).toBe(3);
    expect(t.dominantType).toBe("comparison");
    expect(t.medianWords).toBe(1500);
    expect(t.tablePct).toBe(33);
    expect(t.questionHeadingPct).toBeGreaterThan(50);
    expect(structuralTargetBlock(t)).toContain("dominant format comparison");
    expect(structuralTargetBlock(structuralTargetFrom([]))).toBe("");
  });
});
