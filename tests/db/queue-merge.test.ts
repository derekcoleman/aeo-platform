import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuestionGraph } from "@/lib/demand/question-graph";
import { upsertQuestionGraph } from "@/lib/demand/store";
import { createManualOpportunity, upsertOpportunities, type OpportunityInput } from "@/lib/pipeline/opportunities";

/**
 * The queue's per-producer merge and demand mining's batch keys against the
 * real schema: both are conflict clauses whose meaning only Postgres can
 * check. Runs only with AEO_TEST_DATABASE_URL; everything it creates is under
 * one throwaway organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("queue merge and mining batches against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const Q = randomUUID();

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Merge test', ${`merge-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Merge test', ${`merge-${SITE.slice(0, 8)}.test`}, '/resources', ${`mg-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device) values (${Q}, ${SITE}, 'sso vs scim', 'sso vs scim', 'paa', 'us-en', 'desktop')`;
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  const opp = (source: OpportunityInput["source"], score: number, evidence: Record<string, unknown>): OpportunityInput => ({
    source, title: "sso vs scim", targetQuery: "sso vs scim", questionId: Q, score, scoreBreakdown: { formula: "ev0", by: source, score }, evidence, dedupeKey: `question:${Q}`,
  });
  const row = async () => {
    const [r] = await sql<{ source: string; score: number; score_breakdown: { by: string }; evidence: Record<string, unknown> & { bySource?: Record<string, unknown> } }[]>`
      select source, score::float as score, score_breakdown, evidence from content.opportunities where site_id = ${SITE} and dedupe_key = ${`question:${Q}`}`;
    return r!;
  };

  it("keeps each producer's evidence, and only the row's own producer may lower its score", async () => {
    await upsertOpportunities(SITE, [opp("citation_gap", 60, { snapshotId: "s1", competitorDomains: ["okta.com"] })], sql);
    await upsertOpportunities(SITE, [opp("signal", 40, { signalId: "sig1", seenCount: 4 })], sql);
    let r = await row();
    expect(r.source).toBe("citation_gap");
    expect(r.score).toBe(60);
    expect(r.score_breakdown.by).toBe("citation_gap");
    expect(r.evidence).toMatchObject({ snapshotId: "s1", signalId: "sig1", seenCount: 4 });
    expect(r.evidence.bySource).toEqual({ citation_gap: { snapshotId: "s1", competitorDomains: ["okta.com"] }, signal: { signalId: "sig1", seenCount: 4 } });

    // Another producer can raise it; the owner can re-score it down; neither loses the other's evidence.
    await upsertOpportunities(SITE, [opp("signal", 75, { signalId: "sig2", seenCount: 6 })], sql);
    expect((await row()).score).toBe(75);
    await upsertOpportunities(SITE, [opp("citation_gap", 55, { snapshotId: "s2", competitorDomains: [] })], sql);
    r = await row();
    expect(r.score).toBe(55);
    expect(r.evidence.bySource).toMatchObject({ citation_gap: { snapshotId: "s2" }, signal: { signalId: "sig2" } });

    // A hand-made request on the same question merges too.
    await createManualOpportunity(SITE, { title: "SSO vs SCIM", questionId: Q, note: "for the launch" }, sql);
    r = await row();
    expect(r.evidence).toMatchObject({ manual: true, note: "for the launch", snapshotId: "s2", signalId: "sig2" });
    expect(Object.keys(r.evidence.bySource ?? {}).sort()).toEqual(["citation_gap", "manual", "signal"]);
  });

  it("a retried mining batch adds its sightings once; a new batch adds them again", async () => {
    const graph: QuestionGraph = {
      questions: [{ text: "What is SCIM?", normalized: "what is scim", source: "autocomplete", seedTerm: "scim", parent: null, depth: 1, seenCount: 2, demandScore: 15.85, clusterIndex: 0 }],
      clusters: [{ index: 0, name: "What is SCIM?", members: [0] }],
      stats: { queriesIssued: 1, cachedQueries: 0, costUsd: 0, rawCandidates: 1, embeddingModel: null },
    };
    const opts = { locale: "us-en", device: "desktop", embeddingModel: null };
    await upsertQuestionGraph(SITE, graph, { ...opts, batchKey: "run-a:0" }, sql);
    await upsertQuestionGraph(SITE, graph, { ...opts, batchKey: "run-a:0" }, sql);
    const seen = async () => (await sql<{ seen_count: number }[]>`select seen_count from measure.questions where site_id = ${SITE} and normalized = 'what is scim'`)[0]!.seen_count;
    expect(await seen()).toBe(2);
    const clusters = await sql<{ question_count: number }[]>`select question_count from measure.question_clusters where site_id = ${SITE}`;
    expect(clusters).toEqual([{ question_count: 1 }]);
    await upsertQuestionGraph(SITE, graph, { ...opts, batchKey: "run-b:0" }, sql);
    expect(await seen()).toBe(4);
  });

  it("a cluster whose centroid is near a stored one from the same model joins it", async () => {
    const vec = (lead: number) => Array.from({ length: 1536 }, (_, i) => (i === 0 ? lead : i === 1 ? 1 - lead : 0));
    const graph = (centroid: number[], text: string): QuestionGraph => ({
      questions: [{ text, normalized: text.toLowerCase(), source: "autocomplete", seedTerm: "sso", parent: null, depth: 1, seenCount: 1, demandScore: 10, clusterIndex: 0 }],
      clusters: [{ index: 0, name: text, members: [0], centroid }],
      stats: { queriesIssued: 1, cachedQueries: 0, costUsd: 0, rawCandidates: 1, embeddingModel: "text-embedding-3-small" },
    });
    const opts = { locale: "us-en", device: "desktop", embeddingModel: "text-embedding-3-small" };
    await upsertQuestionGraph(SITE, graph(vec(1), "what is sso"), { ...opts, batchKey: "run-c:0" }, sql);
    await upsertQuestionGraph(SITE, graph(vec(0.95), "how does sso work"), { ...opts, batchKey: "run-d:0" }, sql);
    await upsertQuestionGraph(SITE, graph(vec(0), "best pizza"), { ...opts, batchKey: "run-e:0" }, sql);
    const rows = await sql<{ name: string; question_count: number }[]>`
      select name, question_count from measure.question_clusters where site_id = ${SITE} and embedding_model = 'text-embedding-3-small' order by name`;
    expect(rows).toEqual([{ name: "best pizza", question_count: 1 }, { name: "what is sso", question_count: 2 }]);
  });
});
