import { describe, expect, it } from "vitest";
import { hashEmbedder, EMBEDDING_DIMENSIONS } from "@/lib/ai/embed";
import { bridgeSignalsToOpportunities, detectCompetitorSpikes, detectTermSpikes, detectUnansweredQuestions, poissonZ, scanSignals, upsertSignals } from "@/lib/context/signals";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-01T00:00:00Z");

describe("poissonZ / detectors", () => {
  it("z-scores the 7-day count against the 30-day expectation with a floor of 1", () => {
    expect(poissonZ(7, 30)).toBeCloseTo(0, 5);
    expect(poissonZ(9, 12)).toBeCloseTo((9 - 2.8) / Math.sqrt(2.8), 4);
    expect(poissonZ(5, 0)).toBe(5);
  });

  it("detectTermSpikes keeps only terms with n7 ≥ 5 and z ≥ 3, drops stop stems, scores by z and volume", async () => {
    const sql = fakeSql([[/tsvector_to_array/, () => [
      { term: "scim", n7: 9, n30: 12 },
      { term: "steady", n7: 7, n30: 30 },
      { term: "thing", n7: 20, n30: 20 },
    ]]]);
    const out = await detectTermSpikes(ORG, SITE, sql, NOW);
    expect(out.map((s) => s.evidence.term)).toEqual(["scim"]);
    expect(out[0]).toMatchObject({ kind: "term_spike", dedupeText: "term spike scim" });
    expect(out[0]!.score).toBeGreaterThan(50);
  });

  it("detectUnansweredQuestions maps questions to bridgeable signals and excludes ones already in flight (in SQL)", async () => {
    const sql = fakeSql([[/from measure\.questions/, () => [{ id: "q1", text: "does scim require sso", seen_count: 4, demand_score: 60, source: "paa" }]]]);
    const out = await detectUnansweredQuestions(ORG, SITE, sql);
    expect(out).toEqual([{ kind: "unanswered_question", title: "does scim require sso", dedupeText: "unanswered question does scim require sso", evidence: { questionId: "q1", seenCount: 4, demandScore: 60, source: "paa" }, score: 50, questionId: "q1" }]);
    expect(sql.queries[0]!.text).toContain("status in ('queued', 'in_progress', 'published')");
  });

  it("detectCompetitorSpikes queries each competitor's aliases as quoted FTS phrases, never substrings", async () => {
    const sql = fakeSql([
      [/from context\.entities/, () => [{ id: "e1", org_id: ORG, type: "competitor", name: "Okta", aliases: ["Okta Workforce"], wikidata_id: null, description: null }]],
      [/websearch_to_tsquery/, () => [{ n7: 8, n30: 9 }]],
    ]);
    const out = await detectCompetitorSpikes(ORG, SITE, sql, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatchObject({ entityId: "e1", n7: 8, n30: 9 });
    expect(sql.queries[1]!.values).toContain('"Okta" OR "Okta Workforce"');
  });
});

describe("upsertSignals / bridge", () => {
  const found = [
    { kind: "term_spike" as const, title: "scim spiking", dedupeText: "term spike scim", evidence: { term: "scim" }, score: 40 },
    { kind: "term_spike" as const, title: "scim spiking again", dedupeText: "term spike scim", evidence: { term: "scim" }, score: 55 },
    { kind: "unanswered_question" as const, title: "q", dedupeText: "unanswered question q", evidence: {}, score: 10 },
  ];

  it("merges a near-duplicate of the same kind (in-batch and against existing rows) and inserts the rest", async () => {
    const embedder = hashEmbedder(EMBEDDING_DIMENSIONS);
    const [existingVec] = await embedder.embed(["term spike scim"]);
    const sql = fakeSql([
      [/select id, kind, dedupe_embedding::text/, () => [{ id: "old", kind: "term_spike", embedding: JSON.stringify(existingVec) }]],
      [/insert into context\.signals/, () => [{ id: "new" }]],
    ]);
    const s = await upsertSignals(ORG, SITE, found, { embedder, sql, now: NOW });
    expect(s).toEqual({ inserted: 1, merged: 2 });
    const merges = sql.queries.filter((q) => q.text.includes("seen_count = seen_count + 1"));
    expect(merges).toHaveLength(2);
    expect(merges[1]!.values[1]).toBe(55);
  });

  it("without a usable embedder every signal inserts with a null embedding", async () => {
    const sql = fakeSql([[/insert into context\.signals/, () => [{ id: "x" }]]]);
    const s = await upsertSignals(ORG, SITE, found, { embedder: hashEmbedder(64), sql, now: NOW });
    expect(s).toEqual({ inserted: 3, merged: 0 });
    expect(sql.queries.find((q) => q.text.includes("insert into context.signals"))!.values.slice(6, 8)).toEqual([null, null]);
  });

  it("bridges only unanswered questions into opportunities (source signal, question dedupe key) and marks them bridged", async () => {
    const sql = fakeSql([
      [/from context\.signals/, () => [
        { id: "s1", title: "does scim require sso", score: 50, evidence: { questionId: "q1", demandScore: 60 } },
        { id: "s2", title: "no question id", score: 50, evidence: {} },
      ]],
      [/insert into content\.opportunities/, () => [{ inserted: true }]],
    ]);
    const r = await bridgeSignalsToOpportunities(ORG, SITE, sql);
    expect(r).toEqual({ bridged: 1 });
    const ins = sql.queries.find((q) => q.text.startsWith("insert into content.opportunities"))!;
    expect(ins.values[1]).toBe("signal");
    expect(ins.values[4]).toBe("q1");
    expect(ins.values[6]).toBe("s1");
    expect(ins.values[12]).toBe("question:q1");
    expect(sql.queries.at(-1)!.text).toContain("set status = 'bridged'");
  });

  it("scanSignals runs the three detectors, upserts and bridges", async () => {
    const sql = fakeSql([
      [/from measure\.questions/, () => [{ id: "q1", text: "q", seen_count: 3, demand_score: 10, source: "paa" }]],
      [/insert into context\.signals/, () => [{ id: "s1" }]],
      [/from context\.signals/, () => [{ id: "s1", title: "q", score: 20, evidence: { questionId: "q1" } }]],
      [/insert into content\.opportunities/, () => [{ inserted: true }]],
    ]);
    const r = await scanSignals(ORG, SITE, { embedder: hashEmbedder(EMBEDDING_DIMENSIONS), sql, now: NOW });
    expect(r).toEqual({ detected: { termSpikes: 0, unansweredQuestions: 1, competitorSpikes: 0 }, inserted: 1, merged: 0, bridged: 1 });
  });
});
