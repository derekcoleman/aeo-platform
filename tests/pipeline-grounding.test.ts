import { describe, expect, it } from "vitest";
import { composeVersion } from "@/lib/pipeline/compose";
import { factMarkerKeys, stripFactMarkers } from "@/lib/pipeline/markdown";
import { groundingGate, mechanicsGate, runQaGates, unmarkedStatistics } from "@/lib/pipeline/qa";
import { author, brief, draft, groundedBrief, internalFact, scimFact, site, soc2Fact } from "./fixtures/pipeline";

const NOW = new Date("2026-09-01T12:00:00Z");

function compose(body = draft.bodyMd, b = groundedBrief) {
  return composeVersion({ draft: { ...draft, bodyMd: body }, brief: b, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: NOW });
}

function qaInput(body = draft.bodyMd, b = groundedBrief) {
  const c = compose(body, b);
  return { title: draft.title, bodyMd: c.bodyMd, bodyHtml: c.bodyHtml, sources: b.sources, facts: b.facts, intent: b.intent, jsonLd: c.page.jsonLd, now: NOW };
}

describe("fact markers", () => {
  it("stay in the stored markdown, are stripped from the HTML, and are reported by compose", () => {
    const c = compose();
    expect(c.bodyMd).toContain("{{fact:product-capability-supports-eeee}}");
    expect(c.bodyHtml).not.toContain("fact:");
    expect(c.bodyHtml).toContain("Every plan does.</p>");
    expect(c.factKeys).toEqual(["product-capability-supports-eeee"]);
    expect(factMarkerKeys("a {{fact:x-1}} b {{ fact:x-1 }} c {{fact:y-2}}")).toEqual(["x-1", "y-2"]);
    expect(stripFactMarkers("Every plan does {{fact:x-1}}.")).toBe("Every plan does.");
  });

  it("count as a citation for the statistics rule and are not placeholders for the mechanics gate", () => {
    expect(unmarkedStatistics("We serve 40% of the market {{fact:metric-share-abcd}}.")).toEqual([]);
    const c = compose();
    expect(mechanicsGate({ title: draft.title, bodyMd: c.bodyMd, bodyHtml: c.bodyHtml, sources: [], intent: "comparative" }).detail.problems).toEqual([]);
    expect(mechanicsGate({ title: draft.title, bodyMd: "x {{fact}} y", bodyHtml: "<p>x y</p>", sources: [], intent: "comparative" }).passed).toBe(false);
  });
});

describe("groundingGate", () => {
  it("passes a draft that cites an offered public fact, and records what it cited", async () => {
    const g = await groundingGate(qaInput());
    expect(g.passed).toBe(true);
    expect(g.detail).toMatchObject({ cited: [scimFact.key], unknown: [], stale: [], nonPublic: [], offeredPublic: 2, required: 1 });
    expect(g.detail.citedFacts).toEqual([scimFact]);
  });

  it("fails an unknown key and an internal fact", async () => {
    const body = draft.bodyMd.replace("{{fact:product-capability-supports-eeee}}", "{{fact:made-up-1234}} {{fact:objection-buyers-ask-about-eee2}}");
    const g = await groundingGate(qaInput(body, { ...groundedBrief, facts: [scimFact, soc2Fact, internalFact] }));
    expect(g.passed).toBe(false);
    expect(g.detail.unknown).toEqual(["made-up-1234"]);
    expect(g.detail.nonPublic).toEqual([internalFact.key]);
  });

  it("fails a stale fact on the live check and routes the run back to the brief", async () => {
    const loadFacts = async (ids: string[]) => ids.map((id) => ({ id, status: id === scimFact.factId ? "superseded" : "verified", visibility: "public", effective: true }));
    const report = await runQaGates(qaInput(), { structureMin: 0, loadFacts });
    const grounding = report.gates.find((g) => g.gate === "grounding")!;
    expect(grounding.passed).toBe(false);
    expect((grounding.detail.stale as { key: string; reason: string }[])[0]).toEqual({ key: scimFact.key, reason: "fact is superseded" });
    expect(report.routeTo).toBe("brief");
    expect(report.feedback).toEqual(expect.arrayContaining([expect.stringContaining("can no longer be cited")]));
    expect(report.citedFacts).toEqual([]);
  });

  it("fails a draft that ignores every offered fact once the brain offered enough, with actionable feedback", async () => {
    const body = draft.bodyMd.replace(" {{fact:product-capability-supports-eeee}}", "");
    const report = await runQaGates(qaInput(body), { structureMin: 0 });
    expect(report.passed).toBe(false);
    expect(report.routeTo).toBe("draft");
    expect(report.feedback).toEqual(expect.arrayContaining([expect.stringContaining("states nothing specific to the company")]));
  });

  it("the disabled path: no brain, no facts offered → nothing required, the gate passes and the report shape is unchanged", async () => {
    const body = draft.bodyMd.replace(" {{fact:product-capability-supports-eeee}}", "");
    const report = await runQaGates(qaInput(body, brief), { structureMin: 0 });
    const grounding = report.gates.find((g) => g.gate === "grounding")!;
    expect(grounding.passed).toBe(true);
    expect(grounding.detail).toMatchObject({ offeredPublic: 0, required: 0 });
    expect(report.gates.map((g) => g.gate)).toEqual(["structure", "sources", "grounding", "mechanics", "slop"]);
    expect(report.citedFacts).toEqual([]);
  });

  it("respects minOrgFacts: one offered fact is not enough to demand a citation", async () => {
    const body = draft.bodyMd.replace(" {{fact:product-capability-supports-eeee}}", "");
    const g = await groundingGate(qaInput(body, { ...groundedBrief, facts: [scimFact] }));
    expect(g.passed).toBe(true);
    expect((await groundingGate(qaInput(body, { ...groundedBrief, facts: [scimFact] }), { minOrgFacts: 1 })).passed).toBe(false);
  });
});
