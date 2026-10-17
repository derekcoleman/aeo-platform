import { describe, expect, it } from "vitest";
import { buildAliasIndex, findEntityMentions } from "@/lib/context/entities";
import type { EntityRow } from "@/lib/context/types";
import { extractMentions, listItems, loadMentionIndex, MENTION_EXTRACTOR_VERSION, recommends } from "@/lib/answers/mentions";
import { fakeSql } from "./helpers/fake-sql";

const entity = (id: string, type: EntityRow["type"], name: string, aliases: string[] = []): EntityRow => ({ id, org_id: "org", type, name, aliases, wikidata_id: null, description: null });
const index = buildAliasIndex([
  entity("brand", "brand", "Acme", ["acme.com"]),
  entity("product", "product", "Acme Sync"),
  entity("okta", "competitor", "Okta", ["Okta Workforce"]),
  entity("jc", "competitor", "JumpCloud"),
  entity("notion", "competitor", "Notion"),
]);
const byId = (text: string) => Object.fromEntries(extractMentions(text, index).map((m) => [m.entityId, m]));

describe("findEntityMentions", () => {
  it("reports where each entity is first mentioned, across its aliases", () => {
    const hits = findEntityMentions(index, "We tried Okta Workforce, then JumpCloud, then okta again.");
    expect(Object.fromEntries(hits.map((h) => [h.entity.id, [h.count, h.firstIndex]]))).toEqual({ okta: [2, 9], jc: [1, 30] });
  });
});

describe("listItems", () => {
  it("numbers keep their number; bullets and headings count from 1 per list, and each knows what it sits under", () => {
    const text = [
      "## Best SSO tools",
      "1. Okta: enterprise",
      "2) JumpCloud",
      "Some prose at the margin.",
      "- Acme",
      "  - nested",
      "- Notion",
      "### Okta",
      "### JumpCloud",
    ].join("\n");
    // rank, text, depth, parent
    expect(listItems(text).map((i) => [i.rank, i.text, i.depth, i.parent])).toEqual([
      [1, "Best SSO tools", 0, null],
      [1, "Okta: enterprise", 0, 0],
      [2, "JumpCloud", 0, 0],
      [1, "Acme", 0, 0],
      [1, "nested", 1, 3],
      [2, "Notion", 0, 0],
      [1, "Okta", 0, 0],
      [2, "JumpCloud", 0, 0],
    ]);
    expect(listItems("## 3. Acme Sync").map((i) => [i.rank, i.numbered, i.level])).toEqual([[3, true, 2]]);
    expect(listItems("## **2.** Okta").map((i) => [i.rank, i.text])).toEqual([[2, "Okta"]]);
  });

  it("each item starts its own nested list, and a bullet at a numbered item's indent is its detail", () => {
    const text = ["1. Acme", "   - a", "   - b", "2. Okta", "   - c", "3. Notion", "- d", "- e", "4. JumpCloud"].join("\n");
    expect(listItems(text).map((i) => [i.rank, i.text, i.depth, i.parent])).toEqual([
      [1, "Acme", 0, null],
      [1, "a", 1, 0],
      [2, "b", 1, 0],
      [2, "Okta", 0, null],
      [1, "c", 1, 3],
      [3, "Notion", 0, null],
      [1, "d", 1, 5],
      [2, "e", 1, 5],
      [4, "JumpCloud", 0, null],
    ]);
  });

  it("reads bold numbers as numbers, not as bullets or prose", () => {
    const text = ["**1. Okta** – enterprise default.", "", "**2.** Acme – simple.", "**Note:** prices vary.", "1.5 million teams use them.", "2026 was busy."].join("\n");
    expect(listItems(text).map((i) => [i.rank, i.text, i.numbered])).toEqual([
      [1, "Okta** – enterprise default.", true],
      [2, "Acme – simple.", true],
    ]);
  });
});

describe("recommends", () => {
  it("finds a recommending cue unless a negation sits in the three words before it", () => {
    expect(recommends("For most teams we recommend Okta.")).toBe(true);
    expect(recommends("JumpCloud is the best overall option for SMBs.")).toBe(true);
    expect(recommends("Acme is ideal for startups")).toBe(true);
    expect(recommends("I would not recommend Okta here.")).toBe(false);
    expect(recommends("We don’t recommend it.")).toBe(false);
    expect(recommends("Avoid the top pick if you are small.")).toBe(false);
    expect(recommends("Okta is not the best choice for small teams.")).toBe(false);
    expect(recommends("Okta has many integrations.")).toBe(false);
    // The negation is too far back to be about the cue.
    expect(recommends("It is not cheap, but for scale we recommend Okta.")).toBe(true);
  });
});

describe("extractMentions", () => {
  it("matches whole words only, counts every alias as its entity, and marks the brand and its products", () => {
    const m = byId("Notionally, Acme Sync and acme.com beat Okta Workforce; okta is pricier.");
    expect(Object.keys(m).sort()).toEqual(["okta", "product", "brand"].sort());
    expect(m.brand).toMatchObject({ isBrand: true, matchedAlias: "acme.com", mentionCount: 1 });
    expect(m.product).toMatchObject({ isBrand: true, name: "Acme Sync", firstOffset: 12 });
    expect(m.okta).toMatchObject({ isBrand: false, mentionCount: 2, isListed: false, listRank: null, isRecommended: false });
  });

  it("ranks the entity each list item names first, and the first item is recommended", () => {
    const text = ["Top SSO providers:", "1. **Okta** — the enterprise default, pricier than JumpCloud.", "2. **JumpCloud**: good for SMBs.", "3. Acme: newer."].join("\n");
    const m = byId(text);
    expect([m.okta!.listRank, m.jc!.listRank, m.brand!.listRank]).toEqual([1, 2, 3]);
    expect([m.okta!.isRecommended, m.jc!.isRecommended, m.brand!.isRecommended]).toEqual([true, false, false]);
    expect(m.brand!.isListed).toBe(true);
    // Ordered by first mention.
    expect(extractMentions(text, index).map((x) => x.entityId)).toEqual(["okta", "jc", "brand"]);
  });

  it("a title heading ranks nothing, whatever it names", () => {
    // The heading echoes the prompt: Okta is what the answer replaces, not its pick.
    const alternatives = byId(["## Best Okta alternatives for startups", "", "If Okta is too expensive, consider these:", "", "1. **Acme** — simple setup.", "2. **JumpCloud** — directory included."].join("\n"));
    expect([alternatives.okta!.listRank, alternatives.okta!.isListed, alternatives.okta!.isRecommended]).toEqual([null, false, false]);
    expect([alternatives.brand!.listRank, alternatives.brand!.isRecommended, alternatives.jc!.listRank]).toEqual([1, true, 2]);
    // A "vs" heading names both: neither is ranked, and the answer's verdict is not turned around.
    const versus = byId("## Acme vs Okta\n\nOkta has more integrations, while Acme is cheaper. For most startups Okta is the safer bet.");
    for (const m of [versus.brand!, versus.okta!]) expect([m.listRank, m.isRecommended]).toEqual([null, false]);
    // A lone heading naming one entity, then prose, is a title too.
    expect(byId("# Okta\n\nOkta is an identity provider.").okta).toMatchObject({ listRank: null, isRecommended: false });
  });

  it("sibling headings that each name one entity rank, by place in the run; numbered headings keep their number", () => {
    const run = byId(["## Best SSO tools", "### Okta", "Enterprise default.", "- Pricier than Acme", "### JumpCloud", "Directory included.", "### Acme", "### Pricing", "Varies."].join("\n"));
    expect([run.okta!.listRank, run.jc!.listRank, run.brand!.listRank]).toEqual([1, 2, 3]);
    expect([run.okta!.isRecommended, run.jc!.isRecommended, run.brand!.isRecommended]).toEqual([true, false, false]);
    // One entity under several headings is a write-up about it, not a list.
    expect(byId("### What Okta does well\nSSO.\n### Where Okta falls short\nPrice.").okta).toMatchObject({ listRank: null, isRecommended: false });
    expect(byId("### 2. Okta\nEnterprise.\n### 1. Acme\nSimple.").brand).toMatchObject({ listRank: 1, isRecommended: true });
  });

  it("a rival named in an item's detail is not listed: the item's nested bullets and heading section belong to it", () => {
    const nested = byId(["1. **Acme** — simple setup.", "   - Cheaper than Okta for small teams", "   - SCIM included", "2. **Okta** — the enterprise default.", "   - Pricey for startups"].join("\n"));
    expect([nested.brand!.listRank, nested.brand!.isRecommended]).toEqual([1, true]);
    expect([nested.okta!.listRank, nested.okta!.isRecommended]).toEqual([2, false]);
    const section = byId(["### 1. Acme", "Simple.", "- Cheaper than Okta", "### 2. JumpCloud"].join("\n"));
    expect([section.okta!.listRank, section.okta!.isListed]).toEqual([null, false]);
    // Grouped under items that name nobody, the nested lists rank, but only the first of a top-level list is recommended for it.
    const grouped = byId(["- Enterprise:", "  - Okta", "  - JumpCloud", "- Startups:", "  - Acme"].join("\n"));
    expect([grouped.okta!.listRank, grouped.jc!.listRank, grouped.brand!.listRank]).toEqual([1, 2, 1]);
    expect([grouped.okta!.isRecommended, grouped.brand!.isRecommended]).toEqual([false, false]);
  });

  it("reads bold-numbered items as a ranked list", () => {
    const m = byId("Top picks:\n\n**1. Okta** – enterprise default.\n\n**2. Acme** – simple.");
    expect([m.okta!.listRank, m.okta!.isRecommended, m.brand!.listRank, m.brand!.isRecommended]).toEqual([1, true, 2, false]);
  });

  it("recommends what a recommending sentence names, and not what a negated one does", () => {
    const m = byId("We recommend Acme for small teams. I would not recommend Okta for them; JumpCloud is fine.");
    expect(m.brand!.isRecommended).toBe(true);
    // A semicolon ends the sentence, so JumpCloud is not in the negated one, nor in a recommending one.
    expect([m.okta!.isRecommended, m.jc!.isRecommended]).toEqual([false, false]);
  });

  it("returns nothing for an answer that names none of them", () => {
    expect(extractMentions("Single sign-on lets users log in once.", index)).toEqual([]);
    expect(MENTION_EXTRACTOR_VERSION).toBe("mentions-v0");
  });

  it("loads the brand, products and competitors of the org", async () => {
    const sql = fakeSql([[/from context\.entities/, () => [entity("okta", "competitor", "Okta")]]]);
    const idx = await loadMentionIndex("org-1", sql);
    expect(idx.entities.map((e) => e.id)).toEqual(["okta"]);
    expect(sql.queries[0]!.values).toEqual(["org-1", { __array: ["brand", "product", "competitor"] }]);
  });
});
