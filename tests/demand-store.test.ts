import { describe, expect, it } from "vitest";
import type { QuestionGraph } from "@/lib/demand/question-graph";
import { citationGaps, GAP_FRESHNESS_DAYS, isOwnedUrl, listTrackedQuestions, stripWww, upsertQuestionGraph, vectorLiteral, visibilitySummary } from "@/lib/demand/store";
import { batchBySite } from "@/lib/inngest/demand";
import { cosine, hashEmbedder, normalize } from "@/lib/ai/embed";
import { fakeSql, idSequence } from "./helpers/fake-sql";

const SITE = "aaaaaaaa-0000-0000-0000-000000000001";

function graph(embeddingModel: string | null): QuestionGraph {
  const centroid = Array.from({ length: 4 }, (_, i) => (i === 0 ? 1 : 0));
  return {
    questions: [{ text: "What is SCIM?", normalized: "what is scim", source: "autocomplete", seedTerm: "scim", parent: null, depth: 1, seenCount: 2, demandScore: 15.85, clusterIndex: 0 }],
    clusters: [{ index: 0, name: "What is SCIM?", members: [0], centroid }],
    stats: { queriesIssued: 1, cachedQueries: 0, costUsd: 0, rawCandidates: 1, embeddingModel },
  };
}

describe("upsertQuestionGraph", () => {
  it("adds a question's sightings once per mining batch, so a retried batch does not count them twice", async () => {
    const next = idSequence();
    const sql = fakeSql([
      [/insert into measure\.question_clusters/, () => [{ id: next() }]],
      [/insert into measure\.questions/, () => [{ id: next(), inserted: false }]],
    ]);
    await upsertQuestionGraph(SITE, graph("hash-bow"), { locale: "us-en", device: "desktop", embeddingModel: "hash-bow", batchKey: "run-1:0" }, sql);
    const q = sql.queries.find((x) => x.text.startsWith("insert into measure.questions"))!;
    expect(q.text).toContain("seen_count = case when excluded.last_mine_batch is not null and measure.questions.last_mine_batch is not distinct from excluded.last_mine_batch then measure.questions.seen_count else measure.questions.seen_count + excluded.seen_count end");
    expect(q.text).toContain("last_mine_batch = coalesce(excluded.last_mine_batch, measure.questions.last_mine_batch)");
    expect(q.values.at(-1)).toBe("run-1:0");
    // A retried batch finds the cluster it wrote; the lexical fallback never merges by centroid.
    expect(sql.queries[0]!.text).toContain("where site_id = $1 and updated_by_run = $2 and name = $3");
    expect(sql.queries.some((x) => x.text.includes("<=>"))).toBe(false);
    expect(sql.queries.find((x) => x.text.startsWith("insert into measure.question_clusters"))!.values.at(-1)).toBe("run-1:0");
    expect(sql.queries.at(-1)!.text).toContain("set question_count = (select count(*)::int from measure.questions q where q.cluster_id = c.id)");
  });

  it("joins a stored cluster whose centroid is within cosine 0.85 under the same embedding model", async () => {
    const sql = fakeSql([
      [/embedding <=>/, () => [{ id: "existing-cluster" }]],
      [/insert into measure\.questions/, () => [{ id: "q1", inserted: true }]],
    ]);
    await upsertQuestionGraph(SITE, graph("text-embedding-3-small"), { locale: "us-en", device: "desktop", embeddingModel: "text-embedding-3-small", batchKey: "run-2:1" }, sql);
    const near = sql.queries.find((x) => x.text.includes("<=>"))!;
    expect(near.text).toContain("embedding_model = $2");
    expect(near.text).toContain("embedding <=> $3::vector <= $4");
    expect(near.values[3]).toBeCloseTo(0.15);
    expect(sql.queries.some((x) => x.text.startsWith("insert into measure.question_clusters"))).toBe(false);
    expect(sql.queries.find((x) => x.text.startsWith("insert into measure.questions"))!.values).toContain("existing-cluster");
  });
});

describe("tracking scope", () => {
  it("the tier schedulers skip excluded questions, paused or disabled sites and lapsed plans", async () => {
    const sql = fakeSql();
    await listTrackedQuestions("weekly", sql);
    const q = sql.queries[0]!;
    expect(q.text).toContain("not q.excluded");
    expect(q.text).toContain("join app.sites s on s.id = q.site_id");
    expect(q.values).toEqual(["weekly", ["provisioning", "verifying", "active"], ["trialing", "active", "past_due"]]);
  });

  it("a citation gap is judged on the latest native snapshot within the freshness window, whatever it showed", async () => {
    const sql = fakeSql();
    await citationGaps(SITE, 10, sql);
    const q = sql.queries[0]!;
    expect(q.text).toContain("select distinct on (question_id) id, question_id, fetched_at, provider, aio_triggered from measure.v_native_aio");
    expect(q.text).toContain("where site_id = $1 and fetched_at >= now() - make_interval(days => $2)");
    expect(q.text).toContain("where l.aio_triggered is true and not q.excluded");
    expect(q.values.slice(0, 2)).toEqual([SITE, GAP_FRESHNESS_DAYS]);
  });

  it("a gap lists every cited domain and, apart, the named competitors among them", async () => {
    const sql = fakeSql();
    await citationGaps(SITE, 10, sql);
    expect(sql.queries[0]!.text).toContain("coalesce(array_agg(distinct c.domain order by c.domain) filter (where c.source_role = 'competitor'), '{}') as named_competitor_domains");
    // Named competitors are counted by entity: two hosts of one rival are one.
    expect(sql.queries[0]!.text).toContain("(count(distinct coalesce(c.entity_id::text, c.domain)) filter (where c.source_role = 'competitor'))::int as named_competitors");
  });

  it("the Demand page's top competitors are named competitors, not every cited site", async () => {
    const sql = fakeSql([[/as questions_tracked/, () => [{ questions_tracked: 0, aio_triggered: 0, aio_cited: 0, featured_snippets_owned: 0 }]]]);
    await visibilitySummary(SITE, sql);
    expect(sql.queries[1]!.text).toContain("where c.surface = 'ai_overview' and c.source_role = 'competitor' group by c.domain");
  });
});

describe("ownership", () => {
  const own = { domains: ["acme.com", "acme.io"] };
  it("strips www", () => {
    expect(stripWww("WWW.Acme.com")).toBe("acme.com");
    expect(stripWww("acme.com")).toBe("acme.com");
  });
  it("matches canonical and alias domains including www and subdomains", () => {
    expect(isOwnedUrl("https://www.acme.com/resources/x", own)).toBe(true);
    expect(isOwnedUrl("https://docs.acme.io/x", own)).toBe(true);
    expect(isOwnedUrl("https://acme.com.evil.com/x", own)).toBe(false);
    expect(isOwnedUrl("https://notacme.com/x", own)).toBe(false);
    expect(isOwnedUrl("garbage", own)).toBe(false);
  });
});

describe("vectorLiteral", () => {
  it("renders a pgvector literal and zeroes non-finite values", () => {
    expect(vectorLiteral([1, 0.5, Number.NaN])).toBe("[1.0000000,0.5000000,0]");
  });
});

describe("hashEmbedder", () => {
  it("is deterministic, unit-length and similarity-preserving", async () => {
    const e = hashEmbedder(64);
    const [a, b, c] = await e.embed(["what is scim provisioning", "what is scim provisioning?", "best pizza in rome"]);
    expect(a).toEqual(b);
    expect(cosine(a!, b!)).toBeCloseTo(1);
    expect(cosine(a!, c!)).toBeLessThan(0.5);
    expect(Math.hypot(...normalize([3, 4]))).toBeCloseTo(1);
  });
});

describe("batchBySite", () => {
  it("groups by site and splits into batches", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, site_id: i < 3 ? "s1" : "s2", org_id: i < 3 ? "o1" : "o2", text: "", locale: "us-en", device: "desktop", tracking_tier: "weekly" as const }));
    const out = batchBySite(rows, 2);
    expect(out).toEqual([
      { siteId: "s1", orgId: "o1", questionIds: ["q0", "q1"] },
      { siteId: "s1", orgId: "o1", questionIds: ["q2"] },
      { siteId: "s2", orgId: "o2", questionIds: ["q3", "q4"] },
    ]);
  });
});
