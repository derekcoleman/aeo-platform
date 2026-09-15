import { describe, expect, it } from "vitest";
import { ORG_SECTIONS, OPS_SECTIONS, SITE_PAGES, resolveTab, sectionHref, sitePage, sitePageHref } from "@/lib/app/nav";

describe("app navigation model", () => {
  it("routes every project page under the site and keeps the overview on the bare path", () => {
    expect(sitePageHref("s1", "overview")).toBe("/app/sites/s1");
    expect(sitePageHref("s1", "demand")).toBe("/app/sites/s1/demand");
    expect(sitePageHref("s1", sitePage("brain"))).toBe("/app/sites/s1/brain");
    for (const p of SITE_PAGES) expect(sitePageHref("s1", p)).toMatch(/^\/app\/sites\/s1(\/[a-z]+)?$/);
  });

  it("keys are unique and section values are unique within a page", () => {
    const keys = SITE_PAGES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const list of [...SITE_PAGES.map((p) => p.sections ?? []), ORG_SECTIONS, OPS_SECTIONS]) {
      const values = list.map((s) => s.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("deep links to a section with an explicit tab query", () => {
    expect(sectionHref("/app/sites/s1", "checks")).toBe("/app/sites/s1?tab=checks");
    expect(sectionHref("/ops", "LLM spend")).toBe("/ops?tab=LLM%20spend");
  });

  it("resolves a requested tab only when the page has it", () => {
    const sections = sitePage("demand").sections!;
    expect(resolveTab(sections, "questions", "gaps")).toBe("questions");
    expect(resolveTab(sections, "nope", "gaps")).toBe("gaps");
    expect(resolveTab(sections, undefined, "mine")).toBe("mine");
  });
});
