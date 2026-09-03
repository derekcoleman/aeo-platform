import { describe, expect, it } from "vitest";
import { buildAliasIndex, findEntityMentions, normalizeAlias, resolveEntityByName, upsertEntity } from "@/lib/context/entities";
import type { EntityRow } from "@/lib/context/types";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const e = (id: string, type: EntityRow["type"], name: string, aliases: string[] = []): EntityRow => ({ id, org_id: ORG, type, name, aliases, wikidata_id: null, description: null });
const entities = [e("1", "brand", "Acme", ["acme.com"]), e("2", "competitor", "Notion"), e("3", "competitor", "Okta", ["Okta Workforce"]), e("4", "product", "Acme Sync")];

describe("alias resolution", () => {
  it("resolves by exact normalised name or alias only", () => {
    const idx = buildAliasIndex(entities);
    expect(resolveEntityByName(idx, "  ACME ")?.id).toBe("1");
    expect(resolveEntityByName(idx, "acme.com")?.id).toBe("1");
    expect(resolveEntityByName(idx, "Acme Inc")).toBeNull();
    expect(normalizeAlias("Okta   Workforce")).toBe("okta workforce");
  });

  it("never matches a substring: Notion is not in notionally, Okta is not in Dakota", () => {
    const idx = buildAliasIndex(entities);
    const none = findEntityMentions(idx, "Notionally speaking, North Dakota is far from acmeville.");
    expect(none).toEqual([]);
  });

  it("finds whole-word mentions case-insensitively, counting each alias, across punctuation and unicode boundaries", () => {
    const idx = buildAliasIndex(entities);
    const hits = findEntityMentions(idx, "We compared NOTION and Okta Workforce; okta's pricing (Okta) vs Acme Sync. Acme wins—notion loses.");
    const byId = Object.fromEntries(hits.map((h) => [h.entity.id, h.count]));
    expect(byId["2"]).toBe(2);
    expect(byId["3"]).toBe(3);
    expect(byId["4"]).toBe(1);
    expect(byId["1"]).toBe(1);
    expect(hits[0]!.entity.id).toBe("3");
  });
});

describe("upsertEntity", () => {
  it("dedupes aliases against the name and merges on conflict", async () => {
    const sql = fakeSql([[/insert into context\.entities/, (q) => [{ id: "9", org_id: ORG, type: "competitor", name: "Okta", aliases: q.values[3], wikidata_id: null, description: null }]]]);
    const row = await upsertEntity(ORG, { type: "competitor", name: " Okta ", aliases: ["okta", "Okta Workforce", "Okta Workforce", ""] }, sql);
    expect(row.name).toBe("Okta");
    expect(sql.queries[0]!.values[2]).toBe("Okta");
    expect(sql.queries[0]!.values[3]).toEqual({ __array: ["Okta Workforce"] });
    expect(sql.queries[0]!.text).toContain("on conflict (org_id, lower(name)) do update");
  });
});
