import { describe, expect, it } from "vitest";
import { hashEmbedder } from "@/lib/ai/embed";
import {
  QUESTION_MODIFIERS,
  buildQuestionGraph,
  clusterQuestions,
  dedupeByEmbedding,
  demandScore,
  expandSeed,
  isQuestionLike,
  normalizeQuestion,
  type ScoredQuestion,
} from "@/lib/demand/question-graph";
import type { SerpClient, SerpQuery } from "@/lib/serp";

describe("normalizeQuestion / isQuestionLike", () => {
  it("normalises punctuation, case and whitespace", () => {
    expect(normalizeQuestion("  What is   SCIM?! ")).toBe("what is scim");
    expect(normalizeQuestion("Okta vs. Entra")).toBe("okta vs entra");
  });
  it("accepts questions and comparatives, rejects bare nouns", () => {
    expect(isQuestionLike("what is scim provisioning")).toBe(true);
    expect(isQuestionLike("Is SCIM free?")).toBe(true);
    expect(isQuestionLike("okta vs entra")).toBe(true);
    expect(isQuestionLike("scim alternatives")).toBe(true);
    expect(isQuestionLike("scim provisioning")).toBe(false);
  });
});

describe("expandSeed", () => {
  it("prefixes and suffixes every modifier, optionally the alphabet", () => {
    const base = expandSeed("scim");
    expect(base).toContain("what scim");
    expect(base).toContain("scim vs");
    expect(base).toHaveLength(1 + QUESTION_MODIFIERS.prefix.length + QUESTION_MODIFIERS.suffix.length);
    expect(expandSeed("scim", { alphabet: true })).toHaveLength(base.length + 26);
  });
});

describe("demandScore", () => {
  it("rewards repeated sightings and PAA, penalises depth, floors at 1", () => {
    const a = demandScore({ seenCount: 1, source: "autocomplete", depth: 1 });
    const b = demandScore({ seenCount: 3, source: "autocomplete", depth: 1 });
    const c = demandScore({ seenCount: 1, source: "paa", depth: 1 });
    const d = demandScore({ seenCount: 1, source: "autocomplete", depth: 3 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(a);
    expect(d).toBeLessThan(a);
    expect(demandScore({ seenCount: 1, source: "autocomplete", depth: 9 })).toBe(1);
  });
});

/** Suggestions keyed by lowercase query. Unknown queries return nothing. */
function fakeClient(suggestions: Record<string, string[]>, paa: Record<string, string[]> = {}) {
  const issued: string[] = [];
  const at = <T extends object>(q: SerpQuery, base: T) => ({ ...base, provider: "dataforseo" as const, query: q.query, locale: q.locale, device: q.device, fetchedAt: "now", costUsd: 0.001, cached: false });
  const client: SerpClient & { issued: string[] } = {
    issued,
    providers: { bulk: "dataforseo", aio: "dataforseo" },
    async autocomplete(q) {
      issued.push(`ac:${q.query}`);
      return at(q, { suggestions: suggestions[q.query.toLowerCase()] ?? [] });
    },
    async serp(q) {
      issued.push(`serp:${q.query}`);
      return at(q, { organic: [], featuredSnippet: null, aiOverview: null, raw: null, paa: (paa[q.query.toLowerCase()] ?? []).map((question) => ({ question, answerSnippet: "ans", sourceUrl: "https://x.com" })) });
    },
    async aioSerp(q, t) { return this.serp(q, t); },
    async paa(q, t) { return (await this.serp(q, t)).paa; },
    async aiOverview() { return null; },
  };
  return client;
}

const tenant = { orgId: "11111111-1111-1111-1111-111111111111" };
const locale = { country: "us", language: "en" };

describe("buildQuestionGraph", () => {
  it("expands seeds, recurses to depth, dedupes and counts sightings", async () => {
    const client = fakeClient({
      "what scim": ["what is scim provisioning", "what is scim vs sso"],
      "scim vs": ["scim vs sso", "What is SCIM vs SSO?"],
      "what is scim provisioning": ["what is scim provisioning in okta"],
      "what is scim provisioning in okta": ["how does scim provisioning work in okta"],
    });
    const g = await buildQuestionGraph(client, tenant, { seeds: ["scim"], locale, depth: 2 });
    const texts = g.questions.map((q) => q.normalized);
    expect(texts).toContain("what is scim provisioning");
    expect(texts).toContain("what is scim provisioning in okta"); // depth 2
    expect(texts).not.toContain("how does scim provisioning work in okta"); // would be depth 3
    const vs = g.questions.find((q) => q.normalized === "what is scim vs sso");
    expect(vs?.seenCount).toBe(2);
    expect(vs?.depth).toBe(1);
    expect(g.questions.find((q) => q.normalized === "what is scim provisioning in okta")?.parent).toBe("what is scim provisioning");
    expect(g.stats.queriesIssued).toBe(client.issued.length);
    expect(g.stats.costUsd).toBeCloseTo(client.issued.length * 0.001);
    // sorted by demand
    expect(g.questions[0]?.demandScore).toBeGreaterThanOrEqual(g.questions.at(-1)!.demandScore);
  });

  it("respects maxQueries", async () => {
    const client = fakeClient({});
    const g = await buildQuestionGraph(client, tenant, { seeds: ["a", "b"], locale, maxQueries: 5 });
    expect(client.issued).toHaveLength(5);
    expect(g.stats.queriesIssued).toBe(5);
  });

  it("pulls PAA when asked and marks the node as paa with its answer", async () => {
    const client = fakeClient({ "what scim": ["what is scim"] }, { "what scim": ["What is SCIM?", "Does SCIM need SSO?"] });
    const g = await buildQuestionGraph(client, tenant, { seeds: ["scim"], locale, depth: 1, paa: true });
    const n = g.questions.find((q) => q.normalized === "what is scim");
    expect(n?.source).toBe("paa");
    expect(n?.seenCount).toBe(2);
    expect(n?.paaAnswer?.snippet).toBe("ans");
    expect(client.issued.filter((c) => c.startsWith("serp:")).length).toBeGreaterThan(0);
  });

  it("embeds, dedupes near-duplicates and clusters when an embedder is given", async () => {
    const client = fakeClient({
      "what scim": ["what is scim provisioning", "what is scim provisioning?", "what is the best pizza in rome"],
    });
    const g = await buildQuestionGraph(client, tenant, { seeds: ["scim"], locale, depth: 1, embedder: hashEmbedder(), dedupeThreshold: 0.99 });
    expect(g.stats.embeddingModel).toBe("hash-bow");
    expect(g.questions.every((q) => q.embedding?.length === 256)).toBe(true);
    // "?"-only variant collapses in normalisation, so both remain distinct texts
    expect(g.clusters.length).toBeGreaterThanOrEqual(2);
    expect(g.questions.every((q) => q.clusterIndex !== undefined)).toBe(true);
  });
});

function sq(text: string, demand: number, embedding: number[]): ScoredQuestion {
  return { text, normalized: normalizeQuestion(text), source: "autocomplete", seedTerm: "s", parent: null, depth: 1, seenCount: 1, demandScore: demand, embedding };
}

describe("dedupeByEmbedding / clusterQuestions", () => {
  it("merges near-identical vectors into the higher-demand item, summing sightings", () => {
    const items = [sq("what is scim", 5, [1, 0, 0]), sq("what is scim provisioning", 9, [0.999, 0.01, 0]), sq("scim pricing", 3, [0, 1, 0])];
    const out = dedupeByEmbedding(items, 0.95);
    expect(out.map((q) => q.text)).toEqual(["what is scim provisioning", "scim pricing"]);
    expect(out[0]?.seenCount).toBe(2);
  });

  it("clusters by centroid similarity and names the cluster after its best member", () => {
    const items = [sq("what is scim", 9, [1, 0, 0]), sq("what is scim provisioning", 5, [0.9, 0.1, 0]), sq("scim pricing", 3, [0, 1, 0])];
    const clusters = clusterQuestions(items, 0.8);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.name).toBe("what is scim");
    expect(clusters[0]?.members).toHaveLength(2);
    expect(items.map((q) => q.clusterIndex)).toEqual([0, 0, 1]);
  });
});
