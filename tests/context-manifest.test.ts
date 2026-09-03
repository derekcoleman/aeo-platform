import { describe, expect, it } from "vitest";
import type { TextModel } from "@/lib/ai/model";
import { activateManifest, draftManifestFromFacts, insertManifest, loadActiveManifest, manifestDocSchema, manifestPromptBlock } from "@/lib/context/manifest";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const doc = manifestDocSchema.parse({
  brand: { name: "Acme", oneLiner: "Identity for mid-market", category: "IAM" },
  categoryPov: "Provisioning is the product, SSO is table stakes.",
  contrarianTakes: ["SCIM should not be an enterprise upsell"],
  voice: { summary: "Plain, specific.", pairs: [{ do: "name the protocol", dont: "say 'seamless'" }] },
  bannedPhrases: ["seamless", "robust"],
  competitors: [{ name: "Okta", stance: "respectful", neverSay: ["Okta is insecure"] }],
  proofPoints: [{ text: "SCIM on every plan", factId: "eeeeeeee-3000-0000-0000-000000000001" }],
  legalNoGos: ["no customer logos without consent"],
  terminology: [{ term: "workspace", meaning: "a tenant", avoid: ["account"] }],
});

describe("manifestDocSchema / manifestPromptBlock", () => {
  it("fills defaults so a minimal doc validates", () => {
    const m = manifestDocSchema.parse({ brand: { name: "Acme" } });
    expect(m.docVersion).toBe(1);
    expect(m.icp).toEqual([]);
    expect(m.voice.pairs).toEqual([]);
  });

  it("renders every section deterministically and honours section selection and the cap", () => {
    const block = manifestPromptBlock(doc);
    expect(block).toContain("Brand: Acme — IAM. Identity for mid-market");
    expect(block).toContain("- Contrarian take: SCIM should not be an enterprise upsell");
    expect(block).toContain("- Do: name the protocol / Don't: say 'seamless'");
    expect(block).toContain("Never use these phrases: seamless, robust");
    expect(block).toContain("- Okta: respectful (never say: Okta is insecure)");
    expect(block).toContain("Legal no-gos:\n- no customer logos without consent");
    expect(block).toContain('"workspace": a tenant (not: account)');
    expect(manifestPromptBlock(doc)).toBe(block);
    expect(manifestPromptBlock(doc, { sections: ["voice"] })).not.toContain("Okta");
    expect(manifestPromptBlock(doc, { maxChars: 40 }).length).toBe(40);
  });
});

describe("persistence", () => {
  it("insertManifest assigns the next version inside the insert; activateManifest archives the sibling first", async () => {
    const sql = fakeSql([
      [/insert into context\.brand_manifests/, () => [{ id: "m2", org_id: ORG, site_id: null, version: 2, status: "draft", doc, activated_at: null }]],
      [/for update/, () => [{ id: "m2", org_id: ORG, site_id: null, version: 2, status: "draft", doc, activated_at: null }]],
      [/set status = 'active'/, () => [{ id: "m2", org_id: ORG, site_id: null, version: 2, status: "active", doc, activated_at: "now" }]],
    ]);
    const row = await insertManifest({ orgId: ORG, doc, source: { kind: "manual" } }, sql);
    expect(row.version).toBe(2);
    expect(sql.queries[0]!.text).toContain("coalesce(max(version), 0) + 1");
    const active = await activateManifest(ORG, "m2", sql);
    expect(active?.status).toBe("active");
    const texts = sql.queries.map((q) => q.text);
    expect(texts.findIndex((t) => t.includes("set status = 'archived'"))).toBeLessThan(texts.findIndex((t) => t.includes("set status = 'active'")));
  });

  it("loadActiveManifest prefers the site-specific row and re-validates the doc", async () => {
    const sql = fakeSql([[/from context\.brand_manifests/, () => [{ id: "m1", org_id: ORG, site_id: "s1", version: 1, status: "active", doc: { brand: { name: "Acme" } }, activated_at: "x" }]]]);
    const m = await loadActiveManifest(ORG, "s1", sql);
    expect(m?.doc.brand.name).toBe("Acme");
    expect(sql.queries[0]!.text).toContain("order by (site_id is not null) desc");
  });
});

describe("draftManifestFromFacts", () => {
  const facts = (n: number, visibility: "public" | "internal" = "public") =>
    Array.from({ length: n }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, org_id: ORG, site_id: null, type: "product_capability", subject_entity_id: null, subject_text: "Acme", predicate: `does ${i}`, object_text: "x", value_numeric: null, unit: null, confidence: 0.9, effective_from: null, effective_to: null, status: "verified", visibility, source_document_ids: [], source_quote: null, supersedes_id: null, dedupe_key: `k${i}` }));

  function model(reply: unknown): TextModel {
    return { id: "fake", async complete() { return { text: JSON.stringify(reply), usage: { inputTokens: 1, outputTokens: 1, model: "fake" } }; } };
  }

  it("returns null with too few verified facts and never calls the model", async () => {
    const sql = fakeSql([[/from context\.brand_facts/, () => facts(2)]]);
    let called = false;
    const m: TextModel = { id: "fake", async complete() { called = true; throw new Error("no"); } };
    expect(await draftManifestFromFacts(m, { orgId: ORG, brand: { name: "Acme" } }, sql)).toBeNull();
    expect(called).toBe(false);
  });

  it("drops proof points that cite an unoffered or internal fact and inserts a draft", async () => {
    const offered = [...facts(3), ...facts(1, "internal").map((f) => ({ ...f, id: "0000000a-0000-4000-8000-000000000000" }))];
    const sql = fakeSql([
      [/from context\.brand_facts/, () => offered],
      [/insert into context\.brand_manifests/, (q) => [{ id: "m1", org_id: ORG, site_id: null, version: 1, status: "draft", doc: (q.values[3] as { __json: unknown }).__json, activated_at: null }]],
    ]);
    const reply = { ...doc, proofPoints: [{ text: "ok", factId: offered[0]!.id }, { text: "internal", factId: "0000000a-0000-4000-8000-000000000000" }, { text: "made up", factId: "ffffffff-0000-4000-8000-000000000000" }, { text: "unattributed" }] };
    const row = await draftManifestFromFacts(model(reply), { orgId: ORG, brand: { name: "Acme" } }, sql);
    expect(row?.status).toBe("draft");
    expect(row?.doc.proofPoints.map((p) => p.text)).toEqual(["ok", "unattributed"]);
  });
});
