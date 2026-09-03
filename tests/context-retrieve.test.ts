import { describe, expect, it } from "vitest";
import { hashEmbedder, EMBEDDING_DIMENSIONS } from "@/lib/ai/embed";
import { formatContextBlock, recencyDecay, retrieveContext, rrfFuse } from "@/lib/context/retrieve";
import type { EntityRow, FactRow } from "@/lib/context/types";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-01T00:00:00Z");

describe("rrfFuse / recencyDecay", () => {
  it("rewards ids that rank in both lists over a top rank in one", () => {
    const s = rrfFuse([["a", "b", "c"], ["b", "d"]]);
    expect(s.get("b")!).toBeGreaterThan(s.get("a")!);
    expect(s.get("a")!).toBeGreaterThan(s.get("c")!);
    expect(s.get("d")).toBeCloseTo(1 / 62, 6);
  });

  it("halves at the half-life, treats undated as fresh, never exceeds 1", () => {
    expect(recencyDecay("2026-06-03T00:00:00Z", NOW, 90)).toBeCloseTo(0.5, 2);
    expect(recencyDecay(null, NOW, 90)).toBe(1);
    expect(recencyDecay("2027-01-01T00:00:00Z", NOW, 90)).toBe(1);
  });
});

const brand: EntityRow = { id: "e-brand", org_id: ORG, type: "brand", name: "Acme", aliases: [], wikidata_id: null, description: null };
const okta: EntityRow = { id: "e-okta", org_id: ORG, type: "competitor", name: "Okta", aliases: [], wikidata_id: null, description: null };
const fact = (id: string, type: FactRow["type"], entity: string, visibility: FactRow["visibility"] = "public"): FactRow => ({ id, org_id: ORG, site_id: null, type, subject_entity_id: entity, subject_text: entity === "e-okta" ? "Okta" : "Acme", predicate: "supports", object_text: "SCIM", value_numeric: null, unit: null, confidence: 0.9, effective_from: null, effective_to: null, status: "verified", visibility, source_document_ids: [], source_quote: null, supersedes_id: null, dedupe_key: id });

const chunkRow = (id: string, text: string, vec: number | null, fts: number | null, provider = "slack", ts: string | null = "2026-08-30T00:00:00Z") => ({ id, document_id: `d-${id}`, text, vec_rank: vec, fts_rank: fts, provider, kind: "slack_thread", title: null, source_ts: ts, site_id: null, metadata: {} });

describe("retrieveContext", () => {
  it("fuses vector and FTS ranks, decays old Slack chunks, always includes brand facts and facts for mentioned entities, in type priority order", async () => {
    const sql = fakeSql([
      [/^with vec as/, () => [
        chunkRow("both", "Okta migration notes; we ship SCIM", 1, 1),
        chunkRow("vec-only", "vector hit", 2, null),
        chunkRow("fts-old", "old fts hit from long ago", null, 2, "slack", "2025-01-01T00:00:00Z"),
        chunkRow("fts-doc", "google doc hit, undated", null, 3, "google", null),
      ]],
      [/from context\.entities/, () => [brand, okta]],
      [/from context\.brand_facts/, (q) => [fact("f-metric", "metric", "e-brand"), fact("f-pos", "positioning", "e-brand"), fact("f-okta", "competitor_claim", "e-okta")].filter(() => (q.values as unknown[]).some((v) => (v as { __array?: string[] })?.__array?.includes("e-okta")))],
      [/from context\.brand_manifests/, () => [{ id: "m1", org_id: ORG, site_id: null, version: 3, status: "active", doc: { brand: { name: "Acme" } }, activated_at: "x" }]],
    ]);
    const ctx = await retrieveContext({ orgId: ORG, siteId: SITE }, "okta scim migration", { embedder: hashEmbedder(EMBEDDING_DIMENSIONS), sql, asOf: NOW, k: 3 });
    expect(ctx.chunks.map((c) => c.id)).toEqual(["both", "vec-only", "fts-doc"]);
    expect(ctx.chunks[0]!.score).toBeGreaterThan(ctx.chunks[1]!.score);
    expect(ctx.entitiesMentioned.map((e) => e.id)).toEqual(["e-okta"]);
    expect(ctx.facts.map((f) => f.id)).toEqual(["f-pos", "f-metric", "f-okta"]);
    expect(ctx.manifest?.version).toBe(3);
    expect(ctx.stats).toMatchObject({ vectorCandidates: 2, ftsCandidates: 3, fused: 4, embedded: true, embeddingModel: "hash-bow" });
    const q = sql.queries.find((x) => x.text.startsWith("with vec as"))!;
    expect(q.text).toContain("websearch_to_tsquery('english'");
    expect(q.values).toContain(ORG);
    expect(sql.queries[0]!.text).toBe("set local hnsw.ef_search = 200");
  });

  it("skips the vector half for an embedder of the wrong width and still returns facts with an empty query", async () => {
    const sql = fakeSql([
      [/from context\.entities/, () => [brand]],
      [/from context\.brand_facts/, () => [fact("f1", "positioning", "e-brand")]],
      [/from context\.brand_manifests/, () => []],
    ]);
    const ctx = await retrieveContext({ orgId: ORG, siteId: SITE }, "   ", { embedder: hashEmbedder(256), sql });
    expect(ctx.chunks).toEqual([]);
    expect(ctx.facts).toHaveLength(1);
    expect(ctx.stats.embedded).toBe(false);
    expect(sql.queries.some((q) => q.text.startsWith("with vec as"))).toBe(false);
  });

  it("formatContextBlock labels facts with their {{fact:key}} handle and marks internal context as background only", async () => {
    const sql = fakeSql([
      [/from context\.entities/, () => [brand]],
      [/from context\.brand_facts/, () => [fact("eeeeeeee-3000-0000-0000-000000000001", "product_capability", "e-brand"), fact("f-int", "objection", "e-brand", "internal")]],
      [/from context\.brand_manifests/, () => [{ id: "m1", org_id: ORG, site_id: null, version: 1, status: "active", doc: { brand: { name: "Acme" } }, activated_at: "x" }]],
      [/^with vec as/, () => [chunkRow("c1", "long ".repeat(400), 1, null)]],
    ]);
    const ctx = await retrieveContext({ orgId: ORG, siteId: SITE }, "scim", { embedder: hashEmbedder(EMBEDDING_DIMENSIONS), sql });
    const block = formatContextBlock(ctx, { maxChunkChars: 100 });
    expect(block).toContain("Brand manifesto (v1):\nBrand: Acme");
    expect(block).toContain("- {{fact:product-capability-supports-eeee}} [product_capability, public] Acme supports SCIM");
    expect(block).toContain("[objection, internal]");
    expect(block).toContain("Internal context (background only");
    expect(block).toContain("[1] slack/slack_thread 2026-08-30\n");
    expect(block.length).toBeLessThan(900);
  });
});
