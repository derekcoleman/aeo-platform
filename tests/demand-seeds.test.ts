import { describe, expect, it } from "vitest";
import { demandSeeds, mineLocale } from "@/lib/demand/seeds";

const entity = (type: "brand" | "product" | "competitor" | "category", name: string, aliases: string[] = []) => ({ type, name, aliases });

describe("demandSeeds", () => {
  it("prefers tracked topics, then onboarding keywords, then the crawl's suggestions, and never our own names", () => {
    const seeds = demandSeeds({
      siteName: "Acme",
      keywords: ["scim provisioning", "Acme"],
      profile: { name: "Acme Identity", keywords: ["sso for mid-market", "SCIM provisioning", "AcmeSync"], products: [{ name: "AcmeSync", description: "" }] },
      topics: [{ name: "user provisioning", seed_terms: ["scim vs sso", "  user   provisioning "] }],
      entities: [entity("brand", "Acme Identity", ["acme"]), entity("product", "AcmeSync"), entity("category", "identity management"), entity("competitor", "Okta"), entity("competitor", "Entra")],
    });
    expect(seeds).toEqual(["user provisioning", "scim vs sso", "scim provisioning", "sso for mid-market", "identity management", "Okta alternative", "Entra alternative"]);
  });

  it("caps the list and the competitor share", () => {
    const seeds = demandSeeds({
      keywords: Array.from({ length: 40 }, (_, i) => `keyword ${i}`),
      entities: Array.from({ length: 10 }, (_, i) => entity("competitor", `Rival ${i}`)),
    });
    expect(seeds).toHaveLength(30);
    expect(seeds.filter((s) => s.endsWith(" alternative"))).toHaveLength(0);
    const few = demandSeeds({ keywords: ["a b"], entities: Array.from({ length: 10 }, (_, i) => entity("competitor", `Rival ${i}`)) });
    expect(few.filter((s) => s.endsWith(" alternative"))).toHaveLength(5);
  });

  it("is empty when nothing is known", () => {
    expect(demandSeeds({})).toEqual([]);
  });

  it("mineLocale reads country and language from the site locale", () => {
    expect(mineLocale("en-US")).toEqual({ country: "us", language: "en" });
    expect(mineLocale("de_DE")).toEqual({ country: "de", language: "de" });
    expect(mineLocale("fr")).toEqual({ country: "us", language: "fr" });
    expect(mineLocale(null)).toEqual({ country: "us", language: "en" });
  });
});
