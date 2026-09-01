import { describe, expect, it } from "vitest";
import type { TextModel } from "@/lib/ai/model";
import { briefPrompt, generateBrief, insertBrief, loadBrief } from "@/lib/pipeline/briefs";
import { draftPrompt, generateDraft, slugify } from "@/lib/pipeline/draft";
import { estimateCostUsd, modelIdFor } from "@/lib/pipeline/model";
import { fakeSql } from "./helpers/fake-sql";
import { brief, draft, ORG_ID, SITE_ID } from "./fixtures/pipeline";

function fakeModel(reply: unknown, id = "fake-model"): TextModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id,
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      return { text: "```json\n" + JSON.stringify(reply) + "\n```", usage: { inputTokens: 1000, outputTokens: 500, model: id } };
    },
  };
}

const briefCtx = {
  opportunity: { title: "sso vs scim", targetQuery: "sso vs scim", source: "citation_gap", evidence: { competitorDomains: ["okta.com"] } },
  site: { domain: "acme.com", pathPrefix: "/resources", organizationName: "Acme" },
  relatedQuestions: ["does scim require sso"],
  existingPages: [{ url: "https://acme.com/pricing", title: "Pricing" }],
};

describe("prompts", () => {
  it("briefPrompt carries evidence, related questions, pages, and the reviewer note last", () => {
    const p = briefPrompt({ ...briefCtx, note: "Lead with offboarding.", previous: brief });
    expect(p).toContain("Opportunity (citation_gap): sso vs scim");
    expect(p).toContain("- does scim require sso");
    expect(p).toContain("Pricing — https://acme.com/pricing");
    expect(p.indexOf("Previous brief")).toBeLessThan(p.indexOf("Reviewer note"));
    expect(p.indexOf("Reviewer note")).toBeLessThan(p.indexOf("Return JSON"));
  });

  it("draftPrompt lists sources with their verbatim quotes and forbids numbers when there are none", () => {
    const withSources = draftPrompt({ brief, author: { name: "Dana Reyes", jobTitle: "Head of Security" }, site: { organizationName: "Acme", domain: "acme.com" } });
    expect(withSources).toContain("{{src:gartner-2026}}");
    expect(withSources).toContain(`quote: "${brief.sources[0]!.quote}"`);
    expect(withSources).toContain("- [Acme pricing](https://acme.com/pricing)");
    expect(withSources).toContain("Author byline: Dana Reyes, Head of Security");
    const none = draftPrompt({ brief: { ...brief, sources: [] }, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" }, feedback: ["Fix X"] });
    expect(none).toContain("no statistics or numeric claims");
    expect(none).toContain("- Fix X");
  });
});

describe("generate*", () => {
  it("generateBrief validates the model's JSON and writes an llm_calls row with the task key and cost", async () => {
    const sql = fakeSql();
    const model = fakeModel(brief, "claude-opus-5");
    const { spec, run } = await generateBrief(model, briefCtx, { orgId: ORG_ID, siteId: SITE_ID }, sql);
    expect(spec.targetAnswer).toBe(brief.targetAnswer);
    expect(run).toEqual({ model: "claude-opus-5", promptVersion: "brief.v1", inputTokens: 1000, outputTokens: 500, costUsd: estimateCostUsd("claude-opus-5", 1000, 500) });
    const ledger = sql.queries.find((q) => q.text.includes("insert into ops.llm_calls"))!;
    expect(ledger.values.slice(0, 4)).toEqual([ORG_ID, SITE_ID, "pipeline.brief", "claude-opus-5"]);
  });

  it("generateBrief rejects a brief that fails the schema", async () => {
    const sql = fakeSql();
    await expect(generateBrief(fakeModel({ ...brief, targetAnswer: "too short" }), briefCtx, { orgId: ORG_ID, siteId: SITE_ID }, sql)).rejects.toThrow();
  });

  it("generateDraft returns the validated draft and scopes the ledger row to the content item", async () => {
    const sql = fakeSql();
    const { draft: out } = await generateDraft(fakeModel(draft), { brief, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" } }, { orgId: ORG_ID, siteId: SITE_ID, contentItemId: "item-1" }, sql);
    expect(out.bodyMd).toBe(draft.bodyMd);
    expect(sql.queries[0]!.values.at(-1)).toBe("item-1");
  });

  it("insertBrief stores the target answer beside the spec; loadBrief re-validates", async () => {
    const sql = fakeSql([
      [/insert into content\.briefs/, () => [{ id: "b1" }]],
      [/from content\.briefs/, () => [{ id: "b1", org_id: ORG_ID, site_id: SITE_ID, opportunity_id: null, version: 1, status: "drafted", spec: brief, target_answer: brief.targetAnswer }]],
    ]);
    const { id } = await insertBrief({ siteId: SITE_ID, opportunityId: null, version: 1, spec: brief, run: { model: "m", promptVersion: "v", inputTokens: 1, outputTokens: 1, costUsd: 0 } }, sql);
    expect(id).toBe("b1");
    expect(sql.queries[0]!.values[4]).toBe(brief.targetAnswer);
    const row = await loadBrief("b1", sql);
    expect(row?.spec.intent).toBe("comparative");
  });
});

describe("model helpers", () => {
  it("modelIdFor prefers the task env, then the default env, then the built-in", () => {
    const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    expect(modelIdFor("pipeline.draft", base)).toBe("claude-opus-5");
    expect(modelIdFor("pipeline.qa.judge", base)).toBe("claude-sonnet-5");
    expect(modelIdFor("pipeline.draft", { ...base, AEO_MODEL_DEFAULT: "x" })).toBe("x");
    expect(modelIdFor("pipeline.draft", { ...base, AEO_MODEL_DEFAULT: "x", AEO_MODEL_DRAFT: "y" })).toBe("y");
  });

  it("estimateCostUsd uses the price table with a fallback", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBe(3);
    expect(estimateCostUsd("unknown-model", 1_000_000, 1_000_000)).toBe(30);
  });

  it("slugify produces a bounded kebab-case slug", () => {
    expect(slugify("SSO vs SCIM: What Mid-Market Teams Need?")).toBe("sso-vs-scim-what-mid-market-teams-need");
    expect(slugify("Résumé — naïve café")).toBe("resume-naive-cafe");
    expect(slugify("!!!")).toBe("article");
    expect(slugify("a".repeat(100)).length).toBe(80);
  });
});
