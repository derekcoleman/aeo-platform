import { describe, expect, it } from "vitest";
import { buildLlmsTxtResult, validateLlmsTxt } from "@/lib/audit/llms-txt";

const GOOD = `# Acme
> Acme is an identity platform for mid-market SaaS companies.

## Docs
- [Getting started](https://acme.com/docs/start): setup guide

## Product
- [SSO](https://acme.com/sso)
`;

describe("validateLlmsTxt", () => {
  it("accepts a spec-shaped file", () => {
    const v = validateLlmsTxt(GOOD);
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.sections).toEqual(["Docs", "Product"]);
  });

  it("valid is exactly 'no issues' — never true with a non-empty issues list", () => {
    for (const body of ["", "no title here", "# T\nshort\n", GOOD.replace(/https?:\/\/[^)]+/g, ""), "<!doctype html><html></html>"]) {
      const v = validateLlmsTxt(body);
      expect(v.valid).toBe(v.issues.length === 0);
    }
  });

  it("flags a soft-404 HTML page", () => {
    const v = validateLlmsTxt("<html><body>Not found</body></html>");
    expect(v.valid).toBe(false);
    expect(v.issues[0]).toMatch(/HTML page/);
  });
});

describe("buildLlmsTxtResult", () => {
  it("maps a 404 to found=false", () => {
    const r = buildLlmsTxtResult("https://a.com/llms.txt", 404, null);
    expect(r.found).toBe(false);
    expect(r.valid).toBe(false);
  });
  it("maps a 200 with a good body to found+valid", () => {
    const r = buildLlmsTxtResult("https://a.com/llms.txt", 200, GOOD);
    expect(r.found).toBe(true);
    expect(r.valid).toBe(true);
  });
});
