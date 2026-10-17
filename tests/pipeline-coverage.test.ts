import { describe, expect, it } from "vitest";
import { checkCoverage, COVERAGE_CHUNK_COSINE, coverageGuard, tokenJaccard, topicTokens, type GuardedOpportunity } from "@/lib/pipeline/coverage";
import { fakeSql, type FakeSqlHandler } from "./helpers/fake-sql";
import { ORG_ID, SITE_ID } from "./fixtures/pipeline";

const Q = "dddddddd-0000-0000-0000-000000000001";
const ITEM = "cccccccc-3000-0000-0000-000000000001";
const CMS = "cccccccc-7000-0000-0000-000000000001";

const opp = (over: Partial<GuardedOpportunity> = {}): GuardedOpportunity => ({
  id: "opp-1", site_id: SITE_ID, source: "citation_gap", action_type: "new_page", title: "what is the difference between sso and scim",
  target_query: "what is the difference between sso and scim", question_id: Q, topic_id: null, content_item_id: null, evidence: { snapshotId: "s1" }, ...over,
});

/** The site's topics name SCIM, so the default opportunity clears the topical floor. */
const onTopic: [RegExp, FakeSqlHandler][] = [
  [/from app\.sites/, () => [{ org_id: ORG_ID, keywords: [], profile_keywords: null }]],
  [/from measure\.topics/, () => [{ id: "t1", priority: 4, formats: [], status: "active", name: "SCIM", seed_terms: ["scim"] }]],
];
const owned = (rows: unknown[]): [RegExp, FakeSqlHandler] => [/from measure\.v_native_aio/, () => rows];
const titles = (rows: unknown[]): [RegExp, FakeSqlHandler] => [/select 'cms' as kind/, () => rows];
const embedding = (model: string | null): [RegExp, FakeSqlHandler] => [/select embedding_model from measure\.questions/, () => (model ? [{ embedding_model: model }] : [])];
const chunk = (similarity: number, extra: Record<string, unknown> = {}): [RegExp, FakeSqlHandler] => [/context\.context_chunks/, () => [{ url: "https://acme.com/product/scim", title: "SCIM", similarity, content_item_id: null, cms_item_id: null, ...extra }]];

const NOW = new Date("2026-10-01T12:00:00Z");
/** The page the hit resolves to (pageLifecycle). */
const page = (over: Record<string, unknown> = {}): [RegExp, FakeSqlHandler] => [/from \(select 1\) one/, () => [{ cms_item_id: CMS, content_item_id: null, published_at: null, ...over }]];
/** The refresh scan's inventory row for the CMS post (lib/refresh/scan.ts loadInventorySignals), 200 days old by default, plus others. */
const inventory = (over: Record<string, unknown> = {}, others: Record<string, unknown>[] = []): [RegExp, FakeSqlHandler] => {
  const row = (r: Record<string, unknown>) => ({
    id: CMS, site_id: SITE_ID, title: "The SCIM guide", url: "https://acme.com/blog/scim", collection_name: "Blog", content_item_id: null, last_updated: new Date(NOW.getTime() - 200 * 86_400_000),
    is_draft: false, is_archived: false, missing: false, has_body: true, word_count: 1200, heading_count: 6, in_flight: false,
    clicks: 20, clicks_prev: 20, impressions: 500, impressions_prev: 500, position: 6, cited_native: 0, cited_native_prev: 0, cited_profound: 0, cited_profound_prev: 0, ...r,
  });
  return [/from content\.cms_items i\s+left join gsc_by_key/, () => [row(over), ...others.map(row)]];
};
const availability = (): [RegExp, FakeSqlHandler] => [/as gsc,/, () => [{ gsc: true, native: true, profound: false }]];

describe("token Jaccard", () => {
  it("compares the topic words: question words, comparison connectors and title filler drop out, plurals fold", () => {
    expect([...topicTokens("What's the difference between SSO and SCIM?")]).toEqual(["sso", "scim"]);
    expect(tokenJaccard("what is the difference between sso and scim", "SSO vs SCIM: the complete guide")).toBe(1);
    expect(tokenJaccard("sso-vs-scim", "sso vs scim")).toBe(1);
    expect(tokenJaccard("scim provisioning tools", "SCIM provisioning tool")).toBe(1);
    expect(tokenJaccard("scim provisioning for startups", "scim provisioning")).toBeCloseTo(2 / 3);
    expect(tokenJaccard("what is it", "scim")).toBe(0);
  });
});

describe("checkCoverage", () => {
  it("1. an owned page in the organic top 10 that is one of our articles: refresh it", async () => {
    const sql = fakeSql([owned([{ url: "https://acme.com/resources/sso-vs-scim", title: "SSO vs SCIM", position: 4, surface: "organic", content_item_id: ITEM, cms_item_id: null }])]);
    const v = await checkCoverage(opp(), sql);
    expect(v).toMatchObject({ actionType: "refresh", hit: { kind: "serp_owned", contentItemId: ITEM, cmsItemId: null, measure: 4, reason: "https://acme.com/resources/sso-vs-scim already ranks #4 for this question" } });
    // Stops at the first page it can refresh.
    expect(sql.queries).toHaveLength(1);
    const q = sql.queries[0]!;
    expect(q.text).toContain("from measure.v_native_aio where site_id = $1 and question_id = $2");
    expect(q.text).toContain("(c.surface = 'organic' and c.position <= $");
    expect(q.text).toContain("or c.surface = 'featured_snippet'");
    expect(q.text).toContain("content.url_key(canonical_url) = content.url_key(c.url)");
    expect(q.values).toContain(10);
  });

  it("an owned featured snippet on a CMS post: refresh the post in place", async () => {
    const sql = fakeSql([owned([{ url: "https://acme.com/blog/scim", title: null, position: 0, surface: "featured_snippet", content_item_id: null, cms_item_id: CMS }])]);
    expect(await checkCoverage(opp(), sql)).toMatchObject({ actionType: "refresh", hit: { cmsItemId: CMS, surface: "featured_snippet", reason: "https://acme.com/blog/scim already holds the featured snippet for this question" } });
  });

  it("the home page ranks and nothing editable says it: a setup task, never a second page", async () => {
    const sql = fakeSql([owned([{ url: "https://acme.com/", title: "Acme", position: 3, surface: "organic", content_item_id: null, cms_item_id: null }]), embedding(null)]);
    const v = await checkCoverage(opp(), sql);
    expect(v).toMatchObject({ actionType: "setup_task", hit: { kind: "serp_owned", url: "https://acme.com/", contentItemId: null, cmsItemId: null } });
    // It kept looking for a page it could refresh before settling for the setup task.
    expect(sql.queries.map((q) => q.text.slice(0, 30))).toHaveLength(3);
  });

  it("2. a CMS post titled the same way: refresh it; one with no body is a setup task", async () => {
    const sql = fakeSql([
      titles([
        { kind: "cms", id: "other", title: "Okta pricing explained", slug: "okta-pricing", url: "https://acme.com/blog/okta-pricing", content_item_id: null, has_body: true },
        { kind: "cms", id: CMS, title: "SSO vs SCIM: the complete guide", slug: "sso-vs-scim", url: "https://acme.com/blog/sso-vs-scim", content_item_id: null, has_body: true },
      ]),
      embedding(null),
    ]);
    expect(await checkCoverage(opp(), sql)).toMatchObject({ actionType: "refresh", hit: { kind: "title_match", cmsItemId: CMS, contentItemId: null, measure: 1 } });
    const q = sql.queries.find((x) => x.text.includes("select 'cms' as kind"))!;
    expect(q.text).toContain("i.missing_since is null and not i.is_archived and not i.is_draft");
    expect(q.text).toContain("ci.origin = 'pipeline' and ci.status = 'published'");

    const bodiless = fakeSql([titles([{ kind: "cms", id: CMS, title: "SSO vs SCIM", slug: null, url: null, content_item_id: null, has_body: false }]), embedding(null)]);
    expect(await checkCoverage(opp(), bodiless)).toMatchObject({ actionType: "setup_task", hit: { kind: "title_match", cmsItemId: null } });
  });

  it("one of our own published articles under another title: refresh it", async () => {
    const sql = fakeSql([titles([{ kind: "own", id: ITEM, title: "SCIM vs SSO", slug: "scim-vs-sso", url: "https://acme.com/resources/scim-vs-sso", content_item_id: ITEM, has_body: true }])]);
    expect(await checkCoverage(opp(), sql)).toMatchObject({ actionType: "refresh", hit: { kind: "title_match", contentItemId: ITEM } });
  });

  it("3. a page of the site's crawl says the same thing, by embedding: at the threshold it covers, below it does not", async () => {
    const near = fakeSql([embedding("text-embedding-3-small"), chunk(0.91, { cms_item_id: CMS })]);
    expect(await checkCoverage(opp(), near)).toMatchObject({ actionType: "refresh", hit: { kind: "site_similarity", cmsItemId: CMS, measure: 0.91 } });
    const q = near.queries.find((x) => x.text.includes("context.context_chunks"))!;
    expect(q.text).toContain("ch.embedding_model = qn.embedding_model");
    expect(q.text).toContain("where d.provider = 'website' and d.site_id = $");
    expect(q.text).toContain("order by ch.embedding <=> qn.embedding");

    const far = fakeSql([embedding("text-embedding-3-small"), chunk(COVERAGE_CHUNK_COSINE - 0.01)]);
    expect(await checkCoverage(opp(), far)).toEqual({ actionType: "new_page", hit: null });

    const product = fakeSql([embedding("text-embedding-3-small"), chunk(0.88)]);
    expect(await checkCoverage(opp(), product)).toMatchObject({ actionType: "setup_task", hit: { kind: "site_similarity", url: "https://acme.com/product/scim" } });
  });

  it("never compares on the bag-of-words fallback embedding, or without one", async () => {
    const hashBow = fakeSql([embedding("hash-bow"), chunk(0.99)]);
    expect(await checkCoverage(opp(), hashBow)).toEqual({ actionType: "new_page", hit: null });
    expect(hashBow.queries.some((q) => q.text.includes("context.context_chunks"))).toBe(false);
    const none = fakeSql([embedding(null), chunk(0.99)]);
    expect(await checkCoverage(opp(), none)).toEqual({ actionType: "new_page", hit: null });
    expect(none.queries.some((q) => q.text.includes("context.context_chunks"))).toBe(false);
  });

  it("without a question only the title check can run", async () => {
    const sql = fakeSql();
    expect(await checkCoverage(opp({ question_id: null }), sql)).toEqual({ actionType: "new_page", hit: null });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]!.text).toContain("select 'cms' as kind");
  });
});

describe("coverageGuard", () => {
  it("passes a person's request, a refresh and anything already briefed as they are, without checking", async () => {
    for (const o of [opp({ source: "manual" }), opp({ evidence: { manual: true } }), opp({ source: "refresh", action_type: "refresh" }), opp({ content_item_id: ITEM }), opp({ evidence: { cmsItemId: CMS } })]) {
      const sql = fakeSql([owned([{ url: "https://acme.com/", title: null, position: 1, surface: "organic", content_item_id: null, cms_item_id: null }])]);
      const r = await coverageGuard(o, sql);
      expect(r).toMatchObject({ proceed: true, checked: false });
      expect(sql.queries).toHaveLength(0);
    }
    const briefed = fakeSql([[/from content\.briefs/, () => [{ id: "b1" }]], owned([{ url: "https://acme.com/", title: null, position: 1, surface: "organic", content_item_id: null, cms_item_id: null }])]);
    expect(await coverageGuard(opp(), briefed)).toMatchObject({ proceed: true, actionType: "new_page", checked: false });
    expect(briefed.queries).toHaveLength(1);
  });

  it("dismisses automated work nothing ties to the site (auto_topical_floor)", async () => {
    const sql = fakeSql([...onTopic, [/update content\.opportunities/, () => [{ id: "opp-1" }]]]);
    const r = await coverageGuard(opp({ title: "best pizza in boston", target_query: "best pizza in boston" }), sql);
    expect(r).toMatchObject({ proceed: false, dismissReason: "auto_topical_floor" });
    const dismiss = sql.queries.find((q) => q.text.startsWith("update content.opportunities"))!;
    expect(dismiss.values.slice(0, 1)).toEqual(["auto_topical_floor"]);
    expect(dismiss.values[1]).toMatch(/Write about this/);
    // The floor comes first: no coverage check is paid for off-topic work.
    expect(sql.queries.some((q) => q.text.includes("v_native_aio"))).toBe(false);
  });

  it("dismisses a question the site already answers on a page we cannot edit (auto_coverage, setup task)", async () => {
    const sql = fakeSql([...onTopic, owned([{ url: "https://acme.com/", title: "Acme", position: 2, surface: "organic", content_item_id: null, cms_item_id: null }]), embedding(null), [/update content\.opportunities/, () => [{ id: "opp-1" }]]]);
    const r = await coverageGuard(opp(), sql);
    expect(r).toMatchObject({ proceed: false, dismissReason: "auto_coverage" });
    const dismiss = sql.queries.find((q) => q.text.startsWith("update content.opportunities"))!;
    expect(dismiss.values.slice(0, 3)).toEqual(["auto_coverage", expect.stringContaining("https://acme.com/ already ranks #2 for this question"), "setup_task"]);
  });

  it("turns the work into a refresh of the page that covers it, and the run continues from what it returns", async () => {
    const sql = fakeSql([...onTopic, page(), inventory(), owned([{ url: "https://acme.com/blog/scim", title: "SCIM", position: 6, surface: "organic", content_item_id: null, cms_item_id: CMS }]), [/update content\.opportunities/, () => []]]);
    const r = await coverageGuard(opp(), sql, NOW);
    expect(r).toMatchObject({ proceed: true, actionType: "refresh", contentItemId: null, checked: true, evidence: { snapshotId: "s1", cmsItemId: CMS, coverage: { kind: "serp_owned", url: "https://acme.com/blog/scim", measure: 6 } } });
    if (!r.proceed) throw new Error("unreachable");
    expect(r.evidence.reasons).toEqual(["https://acme.com/blog/scim already ranks #6 for this question: one page per question, so this refreshes it"]);
    const update = sql.queries.find((q) => q.text.startsWith("update content.opportunities"))!;
    expect(update.text).toContain("set action_type = $1::content.action_type, content_item_id = coalesce($2, content_item_id)");
    expect(update.text).toContain("evidence = evidence || $3");
    expect(update.values[0]).toBe("refresh");
    expect((update.values[2] as { __json: Record<string, unknown> }).__json).toMatchObject({ cmsItemId: CMS });
    // Claimed under a lock on the page, after checking nothing else is already working on it.
    const texts = sql.queries.map((q) => q.text);
    const lock = texts.findIndex((t) => t.startsWith("select pg_advisory_xact_lock(hashtext($1))"));
    const busy = texts.findIndex((t) => t.startsWith("select id, title from content.opportunities"));
    expect(sql.queries[lock]!.values).toEqual([`coverage:${CMS}`]);
    expect(lock).toBeLessThan(busy);
    expect(busy).toBeLessThan(texts.findIndex((t) => t.startsWith("update content.opportunities")));
    expect(texts[busy]).toContain("and (content_item_id = $3::uuid or evidence->>'cmsItemId' = $4::text)");
    expect(sql.queries[busy]!.values.slice(0, 4)).toEqual([SITE_ID, "opp-1", null, CMS]);
  });

  it("follows the refresh lifecycle: a page changed recently, or already being worked on, is not rewritten again", async () => {
    const hit = owned([{ url: "https://acme.com/blog/scim", title: "SCIM", position: 6, surface: "organic", content_item_id: null, cms_item_id: CMS }]);
    const dismissed = (sql: ReturnType<typeof fakeSql>) => sql.queries.find((q) => q.text.startsWith("update content.opportunities") && q.text.includes("set status = 'dismissed'"));

    const young = fakeSql([...onTopic, page(), inventory({ last_updated: new Date(NOW.getTime() - 10 * 86_400_000) }), hit, [/update content\.opportunities/, () => [{ id: "opp-1" }]]]);
    expect(await coverageGuard(opp(), young, NOW)).toMatchObject({ proceed: false, dismissReason: "auto_coverage", reason: expect.stringContaining("changed 10 days ago, too recently to rewrite") });
    expect(dismissed(young)!.values[0]).toBe("auto_coverage");
    expect(young.queries.some((q) => q.text.includes("pg_advisory_xact_lock"))).toBe(false);

    const busy = fakeSql([...onTopic, page(), inventory(), hit, [/select id, title from content\.opportunities/, () => [{ id: "opp-2", title: "Refresh: The SCIM guide" }]], [/update content\.opportunities/, () => [{ id: "opp-1" }]]]);
    expect(await coverageGuard(opp(), busy, NOW)).toMatchObject({ proceed: false, dismissReason: "auto_coverage", reason: expect.stringContaining("already queued or running (“Refresh: The SCIM guide”)") });
    expect(busy.queries.some((q) => q.text.includes("set action_type = $1::content.action_type"))).toBe(false);

    // One of our own articles: its age is our last publish.
    const ours = fakeSql([...onTopic, page({ cms_item_id: null, content_item_id: ITEM, published_at: new Date(NOW.getTime() - 5 * 86_400_000) }), owned([{ url: "https://acme.com/resources/scim", title: "SCIM", position: 2, surface: "organic", content_item_id: ITEM, cms_item_id: null }]), [/update content\.opportunities/, () => [{ id: "opp-1" }]]]);
    expect(await coverageGuard(opp(), ours, NOW)).toMatchObject({ proceed: false, reason: expect.stringContaining("changed 5 days ago") });
    expect(ours.queries.some((q) => q.text.includes("left join gsc_by_key"))).toBe(false);
  });

  it("gives a protected winner a figures-and-dates update, never a rewrite", async () => {
    // Cited by our own tracker and holding its clicks, above the inventory's median.
    const winner = inventory({ clicks: 300, clicks_prev: 280, impressions: 9000, impressions_prev: 8800, cited_native: 3, cited_native_prev: 2 }, [{ id: "other", clicks: 10 }]);
    const sql = fakeSql([...onTopic, page(), winner, availability(), owned([{ url: "https://acme.com/blog/scim", title: "SCIM", position: 2, surface: "organic", content_item_id: null, cms_item_id: CMS }]), [/update content\.opportunities/, () => []]]);
    const r = await coverageGuard(opp(), sql, NOW);
    expect(r).toMatchObject({ proceed: true, actionType: "update_stats", evidence: { cmsItemId: CMS, protectedWinner: true } });
    if (!r.proceed) throw new Error("unreachable");
    expect(r.evidence.reasons).toEqual(["https://acme.com/blog/scim already ranks #2 for this question: it is cited and holding its traffic, so this updates its figures and dates only"]);
    expect(sql.queries.find((q) => q.text.startsWith("update content.opportunities"))!.values[0]).toBe("update_stats");
  });

  it("never refreshes a page someone took down: a setup task that says so", async () => {
    const sql = fakeSql([...onTopic, owned([{ url: "https://acme.com/resources/sso-vs-scim", title: "SSO vs SCIM", position: 3, surface: "organic", content_item_id: ITEM, cms_item_id: null, taken_down: "retired" }]), embedding(null), [/update content\.opportunities/, () => [{ id: "opp-1" }]]]);
    const r = await coverageGuard(opp(), sql, NOW);
    expect(r).toMatchObject({ proceed: false, dismissReason: "auto_coverage" });
    if (r.proceed) throw new Error("unreachable");
    expect(r.reason).toBe("Not written: https://acme.com/resources/sso-vs-scim already ranks #3 for this question, and it was taken down (retired). Restore that page, or use “Write about this” to have a new page written anyway.");
    expect(sql.queries.find((q) => q.text.includes("set status = 'dismissed'"))!.values[2]).toBe("setup_task");
  });

  it("lets uncovered on-topic work through as a new page, with its fit", async () => {
    const sql = fakeSql([...onTopic, embedding(null)]);
    const r = await coverageGuard(opp(), sql);
    expect(r).toMatchObject({ proceed: true, actionType: "new_page", checked: true, brandFit: { value: 0.6, term: "scim" } });
    expect(sql.queries.some((q) => q.text.startsWith("update content.opportunities"))).toBe(false);
  });
});
