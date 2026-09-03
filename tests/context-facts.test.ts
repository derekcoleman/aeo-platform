import { describe, expect, it } from "vitest";
import type { TextModel } from "@/lib/ai/model";
import { extractFacts, factDedupeKey, factKey, isEffective, loadFactStatuses, renderFact, upsertCandidateFacts, verifyFact, type ExtractedFact } from "@/lib/context/facts";
import type { ContextDocument, EntityRow, FactRow } from "@/lib/context/types";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const brand: EntityRow = { id: "e-brand", org_id: ORG, type: "brand", name: "Acme", aliases: ["acme.com"], wikidata_id: null, description: null };
const doc = (id: string, text: string): ContextDocument => ({ id, org_id: ORG, site_id: SITE, provider: "slack", kind: "slack_thread", title: null, text, metadata: {}, source_ts: "2026-08-01T00:00:00Z", content_sha256: "h", redacted: true });

function fakeModel(reply: unknown): TextModel {
  return { id: "fake", async complete() { return { text: JSON.stringify(reply), usage: { inputTokens: 10, outputTokens: 5, model: "fake" } }; } };
}

const scim: ExtractedFact = { type: "product_capability", subject: "Acme", predicate: "supports", object: "SCIM provisioning on every plan", confidence: 0.9, quote: "we shipped SCIM on all plans", visibility: "public", docRefs: [1] };

describe("keys", () => {
  it("dedupe key normalises type, subject and predicate; fact key is bounded and id-suffixed", () => {
    expect(factDedupeKey("product_capability", "Acme", "Supports!")).toBe("product_capability|acme|supports");
    const k = factKey({ id: "eeeeeeee-3000-0000-0000-000000000001", type: "product_capability", predicate: "supports" });
    expect(k).toBe("product-capability-supports-eeee");
    expect(k).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    expect(factKey({ id: "0123abcd-0000-0000-0000-000000000000", type: "customer_proof", predicate: "x".repeat(100) }).length).toBeLessThanOrEqual(45);
  });

  it("renderFact carries the effective window; isEffective respects both bounds", () => {
    const f = { subject_text: "Acme", predicate: "supports", object_text: "SCIM", effective_from: "2026-03-01", effective_to: null };
    expect(renderFact(f)).toBe("Acme supports SCIM (since 2026-03-01)");
    expect(isEffective(f, new Date("2026-02-01"))).toBe(false);
    expect(isEffective(f, new Date("2026-09-01"))).toBe(true);
    expect(isEffective({ effective_from: null, effective_to: "2026-01-01" }, new Date("2026-09-01"))).toBe(false);
  });
});

describe("extractFacts", () => {
  it("validates the model's JSON, drops facts whose docRefs point past the list, and ledgers the call", async () => {
    const sql = fakeSql();
    const { facts, run } = await extractFacts(fakeModel({ facts: [scim, { ...scim, predicate: "ghost", docRefs: [9] }] }), [doc("d1", "we shipped SCIM on all plans")], { name: "Acme" }, { orgId: ORG, siteId: SITE }, sql);
    expect(facts).toHaveLength(1);
    expect(run.promptVersion).toBe("facts.extract.v1");
    expect(sql.queries[0]!.values.slice(0, 3)).toEqual([ORG, SITE, "context.facts.extract"]);
  });
});

describe("upsertCandidateFacts", () => {
  it("resolves the subject through the brand entity, inserts a candidate and reports inserted vs merged", async () => {
    const sql = fakeSql([
      [/from context\.entities/, () => [brand]],
      [/insert into context\.brand_facts/, () => [{ inserted: true }]],
    ]);
    const s = await upsertCandidateFacts(ORG, SITE, [scim], [doc("d1", "x")], { model: "m", promptVersion: "v" }, sql, brand);
    expect(s).toEqual({ inserted: 1, merged: 0, unchanged: 0, entitiesCreated: 0 });
    const ins = sql.queries.find((q) => q.text.startsWith("insert into context.brand_facts"))!;
    expect(ins.values.slice(0, 7)).toEqual([ORG, SITE, "product_capability", "e-brand", "Acme", "supports", "SCIM provisioning on every plan"]);
    expect(ins.values).toContain("product_capability|e-brand|supports");
    expect(ins.text).toContain("where status = 'candidate' do update");
  });

  it("creates an entity for a typed unknown subject and supersedes a verified fact with a different object", async () => {
    const sql = fakeSql([
      [/from context\.entities/, () => []],
      [/insert into context\.entities/, () => [{ id: "e-okta", org_id: ORG, type: "competitor", name: "Okta", aliases: [], wikidata_id: null, description: null }]],
      [/status = 'verified'/, () => [{ id: "f-old", object_text: "no SCIM on the free plan" }]],
      [/insert into context\.brand_facts/, () => [{ inserted: true }]],
    ]);
    const s = await upsertCandidateFacts(ORG, null, [{ ...scim, type: "competitor_claim", subject: "Okta", subjectType: "competitor", object: "SCIM on every plan since June" }], [doc("d1", "x")], { model: "m", promptVersion: "v" }, sql);
    expect(s.entitiesCreated).toBe(1);
    expect(s.inserted).toBe(1);
    const ins = sql.queries.find((q) => q.text.startsWith("insert into context.brand_facts"))!;
    expect(ins.values).toContain("f-old");
  });

  it("treats the same object on a verified fact as new evidence, not a new candidate", async () => {
    const sql = fakeSql([
      [/from context\.entities/, () => [brand]],
      [/status = 'verified'/, () => [{ id: "f-old", object_text: "SCIM provisioning, on every plan." }]],
    ]);
    const s = await upsertCandidateFacts(ORG, SITE, [scim], [doc("d1", "x")], { model: "m", promptVersion: "v" }, sql, brand);
    expect(s).toEqual({ inserted: 0, merged: 0, unchanged: 1, entitiesCreated: 0 });
    expect(sql.queries.some((q) => q.text.startsWith("insert into context.brand_facts"))).toBe(false);
    expect(sql.queries.some((q) => q.text.includes("set source_document_ids"))).toBe(true);
  });
});

describe("verifyFact / loadFactStatuses", () => {
  const candidate: FactRow = { id: "f-new", org_id: ORG, site_id: null, type: "product_capability", subject_entity_id: "e-brand", subject_text: "Acme", predicate: "supports", object_text: "SCIM", value_numeric: null, unit: null, confidence: 0.9, effective_from: null, effective_to: null, status: "candidate", visibility: "public", source_document_ids: [], source_quote: null, supersedes_id: "f-old", dedupe_key: "k" };

  it("supersedes the old verified fact before flipping the candidate, inside one transaction", async () => {
    const sql = fakeSql([
      [/for update/, () => [candidate]],
      [/set status = 'verified'/, () => [{ ...candidate, status: "verified" }]],
    ]);
    const row = await verifyFact(ORG, "f-new", "u1", sql, new Date("2026-09-01T00:00:00Z"));
    expect(row?.status).toBe("verified");
    const texts = sql.queries.map((q) => q.text);
    expect(texts.findIndex((t) => t.includes("set status = 'superseded'"))).toBeLessThan(texts.findIndex((t) => t.includes("set status = 'verified'")));
    expect(sql.queries.find((q) => q.text.includes("'superseded'"))!.values).toContain("f-old");
  });

  it("refuses to verify anything but a candidate", async () => {
    const sql = fakeSql([[/for update/, () => [{ ...candidate, status: "rejected" }]]]);
    expect(await verifyFact(ORG, "f-new", null, sql)).toBeNull();
  });

  it("loadFactStatuses reports existence, status and effectiveness per id", async () => {
    const sql = fakeSql([[/from context\.brand_facts/, () => [{ id: "a", status: "verified", visibility: "public", effective_from: null, effective_to: "2025-01-01" }]]]);
    expect(await loadFactStatuses(ORG, ["a", "b"], sql, new Date("2026-09-01"))).toEqual([{ id: "a", status: "verified", visibility: "public", effective: false }]);
    expect(await loadFactStatuses(ORG, [], sql)).toEqual([]);
  });
});
