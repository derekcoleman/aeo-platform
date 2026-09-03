import { describe, expect, it } from "vitest";
import { parseHtml } from "@/lib/audit/html";
import { analyzeSchema, extractSchemas } from "@/lib/audit/schema";

function page(jsonld: unknown, extra = "") {
  return parseHtml(`<html><head><script type="application/ld+json">${JSON.stringify(jsonld)}</script></head><body>${extra}</body></html>`);
}

describe("extractSchemas", () => {
  it("flattens @graph and records sameAs", () => {
    const ex = extractSchemas(
      page({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme", sameAs: ["https://x.com/acme"] },
          { "@type": "WebSite", url: "https://acme.com" },
        ],
      }),
      "https://acme.com/",
    );
    expect(ex.items.map((i) => i.type)).toEqual(["Organization", "WebSite"]);
    expect(ex.items[0]!.hasSameAs).toBe(true);
    expect(ex.malformedBlocks).toBe(0);
  });

  it("counts malformed blocks instead of throwing", () => {
    const $ = parseHtml('<script type="application/ld+json">{not json</script>');
    expect(extractSchemas($, "https://a.com/").malformedBlocks).toBe(1);
  });
});

describe("analyzeSchema", () => {
  it("is deterministic and rewards org + article + author", () => {
    const rich = extractSchemas(
      page({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme", sameAs: ["https://x.com/acme"], logo: "l" },
          { "@type": "Article", headline: "h", author: { "@type": "Person", name: "J" }, datePublished: "2026-01-01" },
          { "@type": "BreadcrumbList", itemListElement: [] },
          { "@type": "FAQPage", mainEntity: [] },
        ],
      }),
      "https://acme.com/a",
    );
    const bare = extractSchemas(parseHtml("<p>nothing</p>"), "https://acme.com/");
    const a = analyzeSchema([rich]);
    const b = analyzeSchema([rich]);
    expect(a).toEqual(b);
    expect(a.format).toBe("json-ld");
    expect(a.totalScore).toBeGreaterThan(analyzeSchema([bare]).totalScore);
    expect(analyzeSchema([bare]).format).toBe("none");
    expect(analyzeSchema([bare]).totalScore).toBe(0);
  });
});
