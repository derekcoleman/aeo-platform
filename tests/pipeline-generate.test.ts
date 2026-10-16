import { describe, expect, it } from "vitest";
import { ModelRefusalError, type CompletionOptions, type StopReason, type TextModel } from "@/lib/ai/model";
import { ScoredJsonError } from "@/lib/ai/scored-json";
import { briefPrompt, generateBrief, insertBrief, loadBrief, loadBriefBrain, materializeFacts, type BriefBrain } from "@/lib/pipeline/briefs";
import { draftPrompt, generateDraft, slugify } from "@/lib/pipeline/draft";
import { estimateCostUsd, modelIdFor, ModelTruncatedError, TASK_SETTINGS } from "@/lib/pipeline/model";
import { fakeSql } from "./helpers/fake-sql";
import { brief, draft, groundedBrief, internalFact, MANIFEST_ID, offeredFacts, ORG_ID, scimFact, SITE_ID, soc2Fact } from "./fixtures/pipeline";

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

/** A model that answers from a script, reporting how each answer stopped, and records the options it was called with. */
function scriptedModel(replies: { text: string; stopReason?: StopReason; refusalCategory?: string | null }[], id = "claude-opus-5-5"): TextModel & { calls: CompletionOptions[] } {
  const calls: CompletionOptions[] = [];
  return {
    id,
    calls,
    async complete(_prompt, opts = {}) {
      calls.push(opts);
      const r = replies.shift()!;
      return { text: r.text, usage: { inputTokens: 1000, outputTokens: 500, model: id }, stopReason: r.stopReason, refusalCategory: r.refusalCategory ?? null };
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

const brain: BriefBrain = { facts: offeredFacts, manifest: "Brand: Acme — IAM", manifestVersionId: MANIFEST_ID, contextBlock: "Internal context (background only):\n[1] slack/slack_thread\nwe shipped SCIM" };

describe("brand brain in prompts", () => {
  it("briefPrompt is byte-identical without a brain, and adds manifesto, facts and context with one", () => {
    expect(briefPrompt({ ...briefCtx, brain: null })).toBe(briefPrompt(briefCtx));
    const p = briefPrompt({ ...briefCtx, brain });
    expect(p).toContain("Brand manifesto:\nBrand: Acme — IAM");
    expect(p).toContain(`- ${scimFact.key} [product_capability, public] ${scimFact.text}`);
    expect(p).toContain(`- ${internalFact.key} [objection, internal]`);
    expect(p).toContain("we shipped SCIM");
    expect(p.indexOf("Brand manifesto")).toBeLessThan(p.indexOf("Return JSON"));
    expect(p).toContain("factKeys");
  });

  it("draftPrompt lists only public facts with their markers, or an explicit NONE line; the manifesto is binding", () => {
    const p = draftPrompt({ brief: groundedBrief, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" }, manifest: "Brand: Acme" });
    expect(p).toContain(`- {{fact:${scimFact.key}}} ${scimFact.text}`);
    expect(p).toContain(`- {{fact:${soc2Fact.key}}}`);
    expect(p).toContain("Brand manifesto (voice, terminology, banned phrases, competitor stance — all binding):\nBrand: Acme");
    const withInternal = draftPrompt({ brief: { ...groundedBrief, facts: [internalFact] }, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" } });
    expect(withInternal).not.toContain(internalFact.key);
    expect(withInternal).toContain("Verified brand facts: NONE provided");
  });

  it("materializeFacts resolves model-chosen keys against the offered list, ignores invented ones, and falls back to all public facts", () => {
    const chosen = materializeFacts({ ...brief, factKeys: [soc2Fact.key, "made-up-1"] }, brain);
    expect(chosen.facts).toEqual([soc2Fact]);
    expect(chosen.factKeys).toEqual([soc2Fact.key]);
    expect(chosen.manifestVersionId).toBe(MANIFEST_ID);
    const fallback = materializeFacts({ ...brief, factKeys: [] }, brain);
    expect(fallback.facts).toEqual([scimFact, soc2Fact]);
    expect(materializeFacts({ ...brief, factKeys: ["x"] }, null)).toMatchObject({ factKeys: [], facts: [], manifestVersionId: null });
  });

  it("loadBriefBrain returns null when retrieval throws (the brain never blocks a brief) or finds nothing", async () => {
    const throwing = fakeSql([[/./, () => { throw new Error("db down"); }]]);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await loadBriefBrain({ orgId: ORG_ID, siteId: SITE_ID }, "q", throwing)).toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(await loadBriefBrain({ orgId: ORG_ID, siteId: SITE_ID }, "q", fakeSql())).toBeNull();
  });
});

describe("generate*", () => {
  it("generateBrief validates the model's JSON and writes an llm_calls row with the task key and cost", async () => {
    const sql = fakeSql();
    const model = fakeModel(brief, "claude-opus-5");
    const { spec, run } = await generateBrief(model, briefCtx, { orgId: ORG_ID, siteId: SITE_ID }, sql);
    expect(spec.targetAnswer).toBe(brief.targetAnswer);
    expect(spec.facts).toEqual([]);
    expect(run).toEqual({ model: "claude-opus-5", promptVersion: "brief.v2", inputTokens: 1000, outputTokens: 500, costUsd: estimateCostUsd("claude-opus-5", 1000, 500) });
    const ledger = sql.queries.find((q) => q.text.includes("insert into ops.llm_calls"))!;
    expect(ledger.values.slice(0, 4)).toEqual([ORG_ID, SITE_ID, "pipeline.brief", "claude-opus-5"]);
  });

  it("generateBrief with a brain materialises the model's factKeys into facts and pins the manifest", async () => {
    const sql = fakeSql();
    const { spec } = await generateBrief(fakeModel({ ...brief, factKeys: [scimFact.key] }), { ...briefCtx, brain }, { orgId: ORG_ID, siteId: SITE_ID }, sql);
    expect(spec.facts).toEqual([scimFact]);
    expect(spec.manifestVersionId).toBe(MANIFEST_ID);
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
    const { id } = await insertBrief({ siteId: SITE_ID, opportunityId: null, version: 1, spec: groundedBrief, run: { model: "m", promptVersion: "v", inputTokens: 1, outputTokens: 1, costUsd: 0 } }, sql);
    expect(id).toBe("b1");
    expect(sql.queries[0]!.values[4]).toBe(brief.targetAnswer);
    expect(sql.queries[0]!.values[6]).toBe(MANIFEST_ID);
    const row = await loadBrief("b1", sql);
    expect(row?.spec.intent).toBe("comparative");
  });
});

describe("runJsonTask stop reasons", () => {
  const ledger = (sql: ReturnType<typeof fakeSql>) => sql.queries.filter((q) => q.text.includes("insert into ops.llm_calls"));

  it("sends the task's budget and effort, never a temperature", async () => {
    const model = scriptedModel([{ text: JSON.stringify(brief), stopReason: "end_turn" }]);
    const { run } = await generateBrief(model, briefCtx, { orgId: ORG_ID, siteId: SITE_ID }, fakeSql());
    expect(model.calls[0]).toMatchObject({ json: true, maxTokens: TASK_SETTINGS["pipeline.brief"].maxTokens, effort: "high" });
    expect(model.calls[0]).not.toHaveProperty("temperature");
    expect(run.stopReason).toBe("end_turn");
    expect(TASK_SETTINGS["pipeline.draft"]).toEqual({ maxTokens: 20_000, effort: "high" });
  });

  it("retries a draft cut off at max_tokens once with more room, and records both calls", async () => {
    const sql = fakeSql();
    const model = scriptedModel([
      { text: '{"title": "SSO vs SCIM", "bodyMd": "SSO lets a person', stopReason: "max_tokens" },
      { text: JSON.stringify(draft), stopReason: "end_turn" },
    ]);
    const { draft: out, run } = await generateDraft(model, { brief, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" } }, { orgId: ORG_ID, siteId: SITE_ID, contentItemId: "item-1" }, sql);
    expect(out.title).toBe(draft.title);
    expect(model.calls.map((c) => c.maxTokens)).toEqual([20_000, 30_000]);
    expect(run.stopReason).toBe("end_turn");
    const rows = ledger(sql);
    expect(rows).toHaveLength(2);
    // New ledger columns go before content_item_id, which stays last.
    for (const r of rows) expect(r.values.at(-1)).toBe("item-1");
  });

  it("names the truncation when the retry is cut off too", async () => {
    const sql = fakeSql();
    const cut = { text: '{"title": "SSO vs', stopReason: "max_tokens" as const };
    const err = await generateDraft(scriptedModel([cut, cut]), { brief, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" } }, { orgId: ORG_ID, siteId: SITE_ID }, sql).catch((e) => e);
    expect(err).toBeInstanceOf(ScoredJsonError);
    expect(err.message).toMatch(/cut off at max_tokens=30000/);
    expect(ledger(sql)).toHaveLength(2);
  });

  it("hands a cut-off call back to a caller that retries in its own step, with the budget the retry should get", async () => {
    const ctx = { brief, author: { name: "D" }, site: { organizationName: "Acme", domain: "acme.com" } };
    const scope = { orgId: ORG_ID, siteId: SITE_ID, contentItemId: "item-1" };
    const sql = fakeSql();
    const cut = scriptedModel([{ text: '{"title": "SSO vs', stopReason: "max_tokens" }]);
    const err = await generateDraft(cut, ctx, scope, sql, { maxTokens: TASK_SETTINGS["pipeline.draft"].maxTokens, retryTruncated: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelTruncatedError);
    expect(err).toMatchObject({ model: "claude-opus-5-5", maxTokens: 20_000, retryMaxTokens: 30_000 });
    // One call, and it is in the ledger before the step returns.
    expect(cut.calls).toHaveLength(1);
    expect(ledger(sql)).toHaveLength(1);

    // The retry step asks for the larger budget.
    const roomy = scriptedModel([{ text: JSON.stringify(draft), stopReason: "end_turn" }]);
    const { draft: out } = await generateDraft(roomy, ctx, scope, sql, { maxTokens: err.retryMaxTokens, retryTruncated: false });
    expect(out.title).toBe(draft.title);
    expect(roomy.calls[0]!.maxTokens).toBe(30_000);

    const briefCut = scriptedModel([{ text: "{", stopReason: "max_tokens" }]);
    await expect(generateBrief(briefCut, briefCtx, { orgId: ORG_ID, siteId: SITE_ID }, fakeSql(), { retryTruncated: false })).rejects.toMatchObject({ maxTokens: 16_000, retryMaxTokens: 24_000 });
  });

  it("records a refusal and throws ModelRefusalError instead of parsing it", async () => {
    const sql = fakeSql();
    const err = await generateBrief(scriptedModel([{ text: "", stopReason: "refusal", refusalCategory: "cyber" }]), briefCtx, { orgId: ORG_ID, siteId: SITE_ID }, sql).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect(err).toMatchObject({ model: "claude-opus-5-5", category: "cyber" });
    expect(ledger(sql)).toHaveLength(1);
  });
});

describe("model helpers", () => {
  it("modelIdFor prefers the task env, then the default env, then the built-in", () => {
    const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    expect(modelIdFor("pipeline.brief", base)).toBe("claude-opus-5-5");
    expect(modelIdFor("pipeline.draft", base)).toBe("claude-opus-5-5");
    expect(modelIdFor("pipeline.qa.judge", base)).toBe("claude-sonnet-5-5");
    expect(modelIdFor("context.manifest.draft", base)).toBe("claude-sonnet-5-5");
    expect(modelIdFor("site.profile.extract", base)).toBe("claude-sonnet-5-5");
    expect(modelIdFor("context.facts.extract", base)).toBe("claude-haiku-5-5");
    expect(modelIdFor("pipeline.draft", { ...base, AEO_MODEL_DEFAULT: "x" })).toBe("x");
    expect(modelIdFor("pipeline.draft", { ...base, AEO_MODEL_DEFAULT: "x", AEO_MODEL_DRAFT: "y" })).toBe("y");
  });

  it("estimateCostUsd uses the price table with a fallback", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBe(2);
    expect(estimateCostUsd("unknown-model", 1_000_000, 1_000_000)).toBe(30);
  });

  it("slugify produces a bounded kebab-case slug", () => {
    expect(slugify("SSO vs SCIM: What Mid-Market Teams Need?")).toBe("sso-vs-scim-what-mid-market-teams-need");
    expect(slugify("Résumé — naïve café")).toBe("resume-naive-cafe");
    expect(slugify("!!!")).toBe("article");
    expect(slugify("a".repeat(100)).length).toBe(80);
  });
});
