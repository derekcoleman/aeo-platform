import { describe, expect, it } from "vitest";
import { OPS_SECTIONS, SETTINGS_SECTIONS, SITE_PAGES, STAFF_SETTINGS_SECTIONS, legacySettingsTab, opsHref, pageHrefForSite, pageLabel, resolveTab, sectionHref, settingsHref, settingsSections, sitePage, sitePageHref } from "@/lib/app/nav";

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
    expect(pageHrefForSite("s2", "connectors")).toBe("/settings?site=s2&tab=connectors");
    expect(pageHrefForSite("s2", "settings")).toBe("/settings?site=s2");
    expect(pageHrefForSite("s2", "settings", "billing")).toBe("/settings?site=s2&tab=billing");
    expect(pageHrefForSite("s2", "console")).toBe("/ops?site=s2");
    expect(pageHrefForSite("s2", undefined)).toBe("/app/sites/s2");
    expect(opsHref(null)).toBe("/ops");
    expect(opsHref("s2")).toBe("/ops?site=s2");
    expect(SITE_PAGES.some((p) => p.key === "connectors")).toBe(false);
  });

  it("routes settings by project, by organisation, or bare, and labels every shell page", () => {
    expect(settingsHref()).toBe("/settings");
    expect(settingsHref("s1")).toBe("/settings?site=s1");
    expect(settingsHref(null, "o1")).toBe("/settings?org=o1");
    expect(settingsHref("s1", "o1", "billing")).toBe("/settings?site=s1&org=o1&tab=billing");
    expect(sectionHref(settingsHref("s1"), "general")).toBe("/settings?site=s1&tab=general");
    expect(pageLabel("settings")).toBe("Settings");
    expect(pageLabel("connectors")).toBe("Connectors");
    expect(pageLabel("brain")).toBe("Brand brain");
    expect(pageLabel("console")).toBe("Ops console");
  });

  it("gives staff the deployment and staff tabs, and the theme tab only with a project", () => {
    expect(settingsSections({ isStaff: false, hasSite: true }).map((s) => s.value)).toEqual(SETTINGS_SECTIONS.map((s) => s.value));
    expect(settingsSections({ isStaff: true, hasSite: false }).map((s) => s.value)).toEqual([...SETTINGS_SECTIONS.map((s) => s.value), "deployment", "staff"]);
    expect(settingsSections({ isStaff: true, hasSite: true }).map((s) => s.value)).toEqual([...SETTINGS_SECTIONS.map((s) => s.value), ...STAFF_SETTINGS_SECTIONS.map((s) => s.value)]);
    expect(SETTINGS_SECTIONS.map((s) => s.value)).toContain("connectors");
    expect(OPS_SECTIONS.some((s) => s.value === "staff")).toBe(false);
    expect(legacySettingsTab("settings")).toBe("general");
    expect(legacySettingsTab("organisation")).toBe("general");
    expect(legacySettingsTab("billing")).toBe("billing");
    expect(legacySettingsTab(undefined)).toBeUndefined();
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
