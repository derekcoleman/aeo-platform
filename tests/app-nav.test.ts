import { describe, expect, it } from "vitest";
import { OPS_SECTIONS, SETTINGS_SECTIONS, SITE_PAGES, opsHref, pageHrefForSite, pageLabel, resolveTab, sectionHref, settingsHref, sitePage, sitePageHref } from "@/lib/app/nav";

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
    for (const list of [...SITE_PAGES.map((p) => p.sections ?? []), SETTINGS_SECTIONS, OPS_SECTIONS]) {
      const values = list.map((s) => s.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("keeps the current page when switching project, including the connectors page that lives outside the project list", () => {
    expect(pageHrefForSite("s2", "strategy")).toBe("/app/sites/s2/strategy");
    expect(pageHrefForSite("s2", "overview")).toBe("/app/sites/s2");
    expect(pageHrefForSite("s2", "connectors")).toBe("/app/sites/s2/connectors");
    expect(pageHrefForSite("s2", "settings")).toBe("/settings?site=s2");
    expect(pageHrefForSite("s2", "console")).toBe("/ops?site=s2");
    expect(pageHrefForSite("s2", "setup")).toBe("/ops/setup?site=s2");
    expect(pageHrefForSite("s2", "theme")).toBe("/ops/sites/s2/theme");
    expect(pageHrefForSite("s2", undefined)).toBe("/app/sites/s2");
    expect(opsHref(null)).toBe("/ops");
    expect(opsHref("s2", "setup")).toBe("/ops/setup?site=s2");
    expect(SITE_PAGES.some((p) => p.key === "connectors")).toBe(false);
  });

  it("routes settings by project, by organisation, or bare, and labels every shell page", () => {
    expect(settingsHref()).toBe("/settings");
    expect(settingsHref("s1")).toBe("/settings?site=s1");
    expect(settingsHref(null, "o1")).toBe("/settings?org=o1");
    expect(settingsHref("s1", "o1")).toBe("/settings?site=s1&org=o1");
    expect(sectionHref(settingsHref("s1"), "organisation")).toBe("/settings?site=s1&tab=organisation");
    expect(pageLabel("settings")).toBe("Settings");
    expect(pageLabel("connectors")).toBe("Connectors");
    expect(pageLabel("brain")).toBe("Brand brain");
    expect(pageLabel("console")).toBe("Ops console");
  });

  it("deep links to a section with an explicit tab query", () => {
    expect(sectionHref("/app/sites/s1", "checks")).toBe("/app/sites/s1?tab=checks");
    expect(sectionHref("/ops", "LLM spend")).toBe("/ops?tab=LLM%20spend");
    expect(sectionHref("/ops?site=s1", "health")).toBe("/ops?site=s1&tab=health");
  });

  it("resolves a requested tab only when the page has it", () => {
    const sections = sitePage("demand").sections!;
    expect(resolveTab(sections, "questions", "gaps")).toBe("questions");
    expect(resolveTab(sections, "nope", "gaps")).toBe("gaps");
    expect(resolveTab(sections, undefined, "mine")).toBe("mine");
  });
});
