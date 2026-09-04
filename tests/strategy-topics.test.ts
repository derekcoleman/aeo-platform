import { describe, expect, it } from "vitest";
import { opportunitiesFromCitationGaps } from "@/lib/pipeline/opportunities";
import { addManualPrompt, assignQuestionsToTopics, createTopic, matchTopic, topicInputSchema, topicSlug } from "@/lib/strategy/topics";
import { fakeSql } from "./helpers/fake-sql";

const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const topics = [
  { id: "t-scim", name: "SCIM provisioning", seed_terms: ["scim", "user provisioning"], priority: 5, status: "active" as const },
  { id: "t-sso", name: "Single sign-on", seed_terms: ["sso", "single sign on"], priority: 3, status: "active" as const },
  { id: "t-old", name: "Legacy", seed_terms: ["ldap"], priority: 1, status: "archived" as const },
];

describe("matchTopic", () => {
  it("matches whole words only, prefers the longest term, then the higher priority", () => {
    expect(matchTopic("What is SCIM provisioning?", topics)?.topicId).toBe("t-scim");
    expect(matchTopic("How does user provisioning work with SSO", topics)?.topicId).toBe("t-scim");
    expect(matchTopic("Is SSO enough for compliance?", topics)?.topicId).toBe("t-sso");
    expect(matchTopic("What is a scimitar", topics)).toBeNull();
    expect(matchTopic("ldap vs ad", topics)).toBeNull();
  });
});

describe("topic input", () => {
  it("accepts comma or newline separated lists and normalises formats", () => {
    const parsed = topicInputSchema.parse({ name: "SCIM", seedTerms: "scim, provisioning\nscim api", competitorDomains: "https://www.okta.com/blog, onelogin.com", formats: "comparison,guide", priority: "5", cadencePerMonth: "3" });
    expect(parsed.seedTerms).toEqual(["scim", "provisioning", "scim api"]);
    expect(parsed.formats).toEqual(["comparison", "guide"]);
    expect(parsed.priority).toBe(5);
    expect(topicSlug("SCIM & SSO: what first?")).toBe("scim-sso-what-first");
  });
  it("creates with a de-duplicated slug and lower-cased competitor domains", async () => {
    const sql = fakeSql([
      [/select slug from measure\.topics/, () => [{ slug: "scim" }, { slug: "scim-2" }]],
      [/insert into measure\.topics/, (q) => [{ id: "t1", slug: q.values[2] }]],
    ]);
    const row = await createTopic(SITE, topicInputSchema.parse({ name: "SCIM", competitorDomains: "https://www.Okta.com/blog" }), sql);
    expect(row.slug).toBe("scim-3");
    const insert = sql.queries.find((q) => q.text.startsWith("insert into measure.topics"))!;
    expect(insert.values).toContainEqual({ __array: ["okta.com"] });
  });
});

describe("assignQuestionsToTopics", () => {
  it("updates only questions whose topic changes, in one statement", async () => {
    const sql = fakeSql([
      [/from measure\.topics where site_id/, () => topics.map((t) => ({ ...t, org_id: "o", site_id: SITE, slug: t.id, description: null, cadence_per_month: 2, formats: [], competitor_domains: [], notes: null, created_at: "", updated_at: "" }))],
      [/select id, text, topic_id from measure\.questions/, () => [
        { id: "q1", text: "What is SCIM provisioning?", topic_id: null },
        { id: "q2", text: "Is SSO enough?", topic_id: "t-sso" },
        { id: "q3", text: "Unrelated pricing question", topic_id: null },
      ]],
    ]);
    const r = await assignQuestionsToTopics(SITE, { reassign: true }, sql);
    expect(r).toEqual({ assigned: 1, considered: 3 });
    const upd = sql.queries.find((q) => q.text.startsWith("update measure.questions q set topic_id"))!;
    expect(upd.values[0]).toEqual({ __array: ["q1"] });
    expect(upd.values[1]).toEqual({ __array: ["t-scim"] });
  });
});

describe("addManualPrompt", () => {
  it("inserts a pinned, tracked manual question attached to the topic", async () => {
    const sql = fakeSql([[/insert into measure\.questions/, () => [{ id: "q9", inserted: true }]]]);
    const r = await addManualPrompt(SITE, { text: "  Best SCIM providers for mid-market?  ", topicId: "t-scim", tier: "daily" }, sql);
    expect(r).toEqual({ id: "q9", inserted: true });
    const q = sql.queries[0]!;
    expect(q.text).toContain("'manual'");
    expect(q.values).toContain("best scim providers for mid market");
    expect(q.values).toContain("daily");
    expect(q.values).toContain("t-scim");
  });
});

describe("topic-aware gap scoring", () => {
  const gap = (id: string, topic: string | null) => ({ question_id: id, topic_id: topic, text: id, demand_score: 50, snapshot_id: "s", fetched_at: "", provider: "serpapi", competitor_domains: ["okta.com"] });
  it("boosts by priority, skips paused topics, and carries the topic's format", () => {
    const weights = new Map([
      ["t-hi", { id: "t-hi", priority: 5, formats: ["comparison"], status: "active" as const }],
      ["t-lo", { id: "t-lo", priority: 1, formats: [], status: "active" as const }],
      ["t-paused", { id: "t-paused", priority: 5, formats: [], status: "paused" as const }],
    ]);
    const rows = opportunitiesFromCitationGaps([gap("a", "t-hi"), gap("b", "t-lo"), gap("c", "t-paused"), gap("d", null)], weights);
    expect(rows.map((r) => r.questionId)).toEqual(["a", "b", "d"]);
    expect(rows[0]!.score).toBeGreaterThan(rows[1]!.score);
    expect(rows[0]!.format).toBe("comparison");
    expect(rows[0]!.topicId).toBe("t-hi");
    expect(rows[2]!.score).toBeGreaterThan(rows[1]!.score);
  });
});
