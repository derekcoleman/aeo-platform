import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vectorLiteral } from "@/lib/ai/embed";
import { listContentItems } from "@/lib/app/content";
import { loadInternalTerms } from "@/lib/context/facts";
import { checkCoverage, coverageGuard } from "@/lib/pipeline/coverage";
import { publishVelocity, velocityVerdict } from "@/lib/pipeline/guard";
import { createManualOpportunity, dismissOpportunity, loadOpportunity, loadQuestionDemand, scanSite, type EV0Breakdown } from "@/lib/pipeline/opportunities";
import { publishVersion, type BuiltPage } from "@/lib/pipeline/publish";
import { insertQaResults } from "@/lib/pipeline/versions";

/**
 * EV0 scoring, the coverage guard, the topical floor and the publishing pace
 * against the real schema (0025): the queries only Postgres can check (the
 * owned-page laterals on content.url_key, the embedding comparison, the
 * dismiss-reason trigger, the pace window). Runs only with
 * AEO_TEST_DATABASE_URL; everything it creates is under one throwaway
 * organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("opportunity scoring and the publish-safety guards against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 2 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const HOST = `ev-${SITE.slice(0, 8)}.test`;
  const TOPIC = randomUUID();
  const WEBFLOW = randomUUID();
  const WEBSITE = randomUUID();
  const CMS = randomUUID();
  const Q_GAP = randomUUID();
  const Q_OFF = randomUUID();
  const Q_HOME = randomUUID();
  const Q_SIMILAR = randomUUID();
  const Q_BOW = randomUUID();

  // A unit vector along one axis: two of them on the same axis are identical (cosine 1).
  const axis = (i: number) => vectorLiteral(Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0)));

  const question = (id: string, text: string, extra: { topic?: string | null; volume?: number | null; intent?: string | null; embedding?: string | null; model?: string | null } = {}) => sql`
    insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, topic_id, search_volume, search_intent, embedding, embedding_model)
    values (${id}, ${SITE}, ${text}, ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()}, 'autocomplete', 'us-en', 'desktop', 20,
            ${extra.topic ?? null}, ${extra.volume ?? null}, ${extra.intent ?? null}, ${extra.embedding ?? null}::vector, ${extra.model ?? null})`;

  const gapSnapshot = async (questionId: string, owned: { url: string; surface: "organic" | "featured_snippet"; position: number } | null) => {
    const [s] = await sql<{ id: string }[]>`
      insert into measure.serp_snapshots (site_id, question_id, provider, locale, device, aio_triggered)
      values (${SITE}, ${questionId}, 'serpapi', 'us-en', 'desktop', true) returning id`;
    await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
      values (${SITE}, ${s!.id}, 'ai_overview', 'https://www.okta.com/scim', 'okta.com', 1, false)`;
    if (owned) {
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, ${owned.surface}, ${owned.url}, ${HOST}, ${owned.position}, true)`;
    }
  };

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'EV0 test', ${`ev0-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'EV0 test', ${HOST}, '/resources', ${`ev-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into measure.topics (id, site_id, name, slug, priority, seed_terms) values (${TOPIC}, ${SITE}, 'SCIM', 'scim', 4, '{scim}')`;
    await sql`insert into context.context_connections (id, org_id, site_id, provider) values (${WEBFLOW}, ${ORG}, ${SITE}, 'webflow'), (${WEBSITE}, ${ORG}, ${SITE}, 'website')`;
    await sql`insert into content.cms_items (id, site_id, connection_id, external_site_id, collection_id, collection_name, collection_slug, external_id, title, slug, url, url_key, body_html)
      values (${CMS}, ${SITE}, ${WEBFLOW}, 'wf', 'c1', 'Blog', 'blog', 'i1', 'Okta vs Entra', 'okta-vs-entra',
              ${`https://www.${HOST}/blog/sso-vs-scim`}, content.url_key(${`https://www.${HOST}/blog/sso-vs-scim`}), '<p>SSO and SCIM.</p>')`;

    await question(Q_GAP, "What is the difference between SSO and SCIM?", { topic: TOPIC, volume: 880, intent: "commercial" });
    await question(Q_OFF, "Best pizza in Boston");
    await question(Q_HOME, "Is SCIM worth it for startups?");
    await question(Q_SIMILAR, "How does SCIM deprovisioning work?", { embedding: axis(3), model: "text-embedding-3-small" });
    await question(Q_BOW, "How does SCIM onboarding work?", { embedding: axis(3), model: "hash-bow" });
    await gapSnapshot(Q_GAP, { url: `https://${HOST}/blog/sso-vs-scim/`, surface: "organic", position: 4 });
    await gapSnapshot(Q_OFF, null);
    await gapSnapshot(Q_HOME, { url: `https://${HOST}/`, surface: "organic", position: 2 });
    await sql`insert into measure.external_metrics (site_id, provider, surface, dimension, date, metrics) values
      (${SITE}, 'gsc', 'gsc_query', ${sql.json({ query: "what is the difference between sso and scim" })}, current_date - 3, ${sql.json({ clicks: 1, impressions: 70 })}),
      (${SITE}, 'gsc', 'gsc_query', ${sql.json({ query: "What is the difference between SSO and SCIM?" })}, current_date - 2, ${sql.json({ clicks: 0, impressions: 30 })}),
      (${SITE}, 'gsc', 'gsc_query', ${sql.json({ query: "what is the difference between sso and scim" })}, current_date - 40, ${sql.json({ clicks: 9, impressions: 900 })})`;

    const [doc] = await sql<{ id: string }[]>`
      insert into context.context_documents (connection_id, site_id, provider, kind, external_id, title, text, content_sha256)
      values (${WEBSITE}, ${SITE}, 'website', 'web_page', ${`https://${HOST}/product/scim`}, 'SCIM provisioning', 'SCIM keeps accounts in sync.', 'sha') returning id`;
    await sql`insert into context.context_chunks (document_id, ordinal, text, embedding, embedding_model)
      values (${doc!.id}, 0, 'SCIM deprovisioning removes access when someone leaves.', ${axis(3)}::vector, 'text-embedding-3-small')`;
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  const version = async (contentItemId: string, no: number) => (await sql<{ id: string }[]>`
    insert into content.content_versions (content_item_id, version_no, title, body_md, body_html) values (${contentItemId}, ${no}, 'V', 'Body', '<p>Body</p>') returning id`)[0]!;
  const page = (path: string) => ({ path, canonicalUrl: `https://${HOST}${path}`, html: "<p>Body</p>", head: { title: "V" }, markdown: "Body", etag: `"${path}"`, jsonLd: {} }) as unknown as BuiltPage;

  const row = async (questionId: string) => {
    const [r] = await sql<{ id: string; status: string; action_type: string; dismiss_reason: string | null; dismissed_reason: string | null; content_item_id: string | null; evidence: Record<string, unknown>; score: number; score_breakdown: EV0Breakdown }[]>`
      select id, status::text as status, action_type::text as action_type, dismiss_reason::text as dismiss_reason, dismissed_reason, content_item_id, evidence, score::float as score, score_breakdown
      from content.opportunities where site_id = ${SITE} and question_id = ${questionId}`;
    return r!;
  };

  it("scores the scanned gaps on EV0 from the question's measured demand, intent and topic", async () => {
    const demand = await loadQuestionDemand(SITE, [Q_GAP], sql);
    // The last 28 days only, both spellings of the query.
    expect(demand.get(Q_GAP)).toMatchObject({ search_volume: 880, search_intent: "commercial", query_impressions: 100 });
    expect(await scanSite(SITE, sql)).toMatchObject({ gaps: 3, inserted: 3 });
    const gap = await row(Q_GAP);
    expect(gap).toMatchObject({ status: "open", action_type: "new_page" });
    expect(gap.score_breakdown).toMatchObject({
      formula: "ev0",
      components: { demand: { source: "search_volume", input: 880 }, intent: { value: "commercial", source: "provider" }, businessValue: { value: 0.8, source: "topic" }, brandFit: { value: 1 }, gap: { type: "aio_other_sources" } },
    });
    expect(gap.score).toBe(gap.score_breakdown.ev);
    expect((await row(Q_OFF)).score_breakdown.components.brandFit.value).toBe(0.3);
    expect((await row(Q_GAP)).score).toBeGreaterThan((await row(Q_OFF)).score);
  });

  it("turns a gap the site already ranks for with a CMS post into a refresh of that post", async () => {
    const gap = await row(Q_GAP);
    const opp = (await loadOpportunity(gap.id, sql))!;
    const r = await coverageGuard(opp, sql);
    expect(r).toMatchObject({ proceed: true, actionType: "refresh", contentItemId: null, evidence: { cmsItemId: CMS, coverage: { kind: "serp_owned", measure: 4 } } });
    expect(await row(Q_GAP)).toMatchObject({ action_type: "refresh", evidence: { cmsItemId: CMS, snapshotId: expect.any(String) } });
  });

  it("dismisses off-topic automated work at the topical floor, and the next scan brings it back once the question is on a topic", async () => {
    const opp = (await loadOpportunity((await row(Q_OFF)).id, sql))!;
    expect(await coverageGuard(opp, sql)).toMatchObject({ proceed: false, dismissReason: "auto_topical_floor" });
    expect(await row(Q_OFF)).toMatchObject({ status: "dismissed", dismiss_reason: "auto_topical_floor", dismissed_reason: expect.stringContaining("Write about this") });
    // Still off topic: the scan leaves it dismissed.
    await scanSite(SITE, sql);
    expect(await row(Q_OFF)).toMatchObject({ status: "dismissed", dismiss_reason: "auto_topical_floor" });
    await sql`update measure.questions set topic_id = ${TOPIC} where id = ${Q_OFF}`;
    await scanSite(SITE, sql);
    const back = await row(Q_OFF);
    expect(back).toMatchObject({ status: "open", dismiss_reason: null, action_type: "new_page" });
    expect(back.score_breakdown.components.brandFit.value).toBe(1);
    expect(await coverageGuard((await loadOpportunity(back.id, sql))!, sql)).toMatchObject({ proceed: true, checked: true });
  });

  it("dismisses a question the home page already ranks for as a setup task; a person's request reopens it as a page", async () => {
    const opp = (await loadOpportunity((await row(Q_HOME)).id, sql))!;
    expect(await coverageGuard(opp, sql)).toMatchObject({ proceed: false, dismissReason: "auto_coverage" });
    expect(await row(Q_HOME)).toMatchObject({ status: "dismissed", dismiss_reason: "auto_coverage", action_type: "setup_task" });
    // A setup task does not pass with time: a scan, however much later, leaves it dismissed.
    await sql`update content.opportunities set updated_at = now() - interval '100 days' where id = ${opp.id}`;
    await scanSite(SITE, sql);
    expect(await row(Q_HOME)).toMatchObject({ status: "dismissed", action_type: "setup_task" });
    await createManualOpportunity(SITE, { title: "Is SCIM worth it for startups?", questionId: Q_HOME }, sql);
    const reopened = await row(Q_HOME);
    expect(reopened).toMatchObject({ status: "open", dismiss_reason: null, action_type: "new_page", evidence: { manual: true } });
    // A person's request passes the guard as it is.
    expect(await coverageGuard((await loadOpportunity(reopened.id, sql))!, sql)).toMatchObject({ proceed: true, checked: false });
  });

  it("finds a page of the site's crawl that says the same thing, but never on the bag-of-words embedding", async () => {
    const base = { site_id: SITE, title: "How does SCIM deprovisioning work?", target_query: "How does SCIM deprovisioning work?" };
    expect(await checkCoverage({ ...base, question_id: Q_SIMILAR }, sql)).toMatchObject({ actionType: "setup_task", hit: { kind: "site_similarity", url: `https://${HOST}/product/scim`, measure: 1 } });
    expect(await checkCoverage({ ...base, question_id: Q_BOW, title: "How does SCIM onboarding work?", target_query: "How does SCIM onboarding work?" }, sql)).toEqual({ actionType: "new_page", hit: null });
  });

  it("matches a CMS post by title", async () => {
    expect(await checkCoverage({ site_id: SITE, question_id: null, title: "Okta vs Entra: which one?", target_query: "okta vs entra" }, sql)).toMatchObject({ actionType: "refresh", hit: { kind: "title_match", cmsItemId: CMS } });
  });

  it("dismisses with a person's reason only what is still open", async () => {
    const { id } = await createManualOpportunity(SITE, { title: "SCIM deprovisioning", questionId: Q_SIMILAR }, sql);
    expect(await dismissOpportunity(id, "low_value", "dismissed in app", sql)).toEqual({ applied: true });
    expect(await dismissOpportunity(id, "duplicate", "again", sql)).toEqual({ applied: false });
    expect(await row(Q_SIMILAR)).toMatchObject({ status: "dismissed", dismiss_reason: "low_value" });
  });

  it("holds the pipeline at the site's publishing pace until the oldest publish of the week leaves the window", async () => {
    // The pace alone (velocityVerdict): publishGuard also reads platform-wide controls, which other DB tests toggle.
    const [one, two] = await sql<{ id: string }[]>`insert into content.content_items (site_id, slug, title, status, first_published_at, published_at, pipeline_published_at) values
      (${SITE}, 'one', 'One', 'published', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'),
      (${SITE}, 'two', 'Two', 'published', now() - interval '40 days', now() - interval '1 day', now() - interval '1 day'),
      (${SITE}, 'old', 'Old', 'published', now() - interval '120 days', now() - interval '120 days', now() - interval '120 days'),
      (${SITE}, 'rolled-back', 'Rolled back', 'published', now() - interval '120 days', now() - interval '2 hours', now() - interval '120 days')
      returning id`;
    const pace = await publishVelocity(SITE, sql, {} as NodeJS.ProcessEnv);
    // A refresh yesterday of a 40-day-old page counts; a page untouched for 120 days does not, nor one an editor rolled back today.
    expect(pace).toMatchObject({ cap: 2, published7d: 2, published90d: 2 });
    const [oldest] = await sql<{ at: Date }[]>`select pipeline_published_at as at from content.content_items where id = ${one!.id}`;
    expect(pace.nextSlotAt!.getTime()).toBe(new Date(oldest!.at).getTime() + 7 * 86_400_000);
    expect(velocityVerdict(pace)).toMatchObject({ ok: false, until: pace.nextSlotAt });
    expect(velocityVerdict(await publishVelocity(SITE, sql, { AEO_PUBLISH_VELOCITY_MAX: "1" } as unknown as NodeJS.ProcessEnv))).toMatchObject({ ok: false });

    // Publishing an item already in the window adds no page to it: its own publish never holds it (a retried publish step included).
    const again = await publishVelocity(SITE, sql, {} as NodeJS.ProcessEnv, { contentItemId: two!.id });
    expect(again).toMatchObject({ published7d: 1, nextSlotAt: pace.nextSlotAt });
    expect(velocityVerdict(again)).toEqual({ ok: true });
    // A rollback moves published_at only.
    const rolledBack = (await sql<{ id: string }[]>`select id from content.content_items where site_id = ${SITE} and slug = 'rolled-back'`)[0]!.id;
    await publishVersion({ contentItemId: rolledBack, versionId: (await version(rolledBack, 1)).id, siteId: SITE, page: page("/resources/rolled-back"), restore: true }, sql);
    expect(await publishVelocity(SITE, sql, {} as NodeJS.ProcessEnv)).toMatchObject({ published7d: 2 });
    // The pipeline's publish counts.
    await publishVersion({ contentItemId: rolledBack, versionId: (await version(rolledBack, 2)).id, siteId: SITE, page: page("/resources/rolled-back") }, sql);
    expect(await publishVelocity(SITE, sql, {} as NodeJS.ProcessEnv)).toMatchObject({ published7d: 3 });
  });

  it("lists a version the safety gate sent to a person as passed, for review, not as failing QA", async () => {
    const [item] = await sql<{ id: string }[]>`insert into content.content_items (site_id, slug, title, status) values (${SITE}, 'reviewed', 'Reviewed', 'draft') returning id`;
    const v = await version(item!.id, 1);
    await sql`update content.content_items set current_version_id = ${v.id} where id = ${item!.id}`;
    await insertQaResults(v.id, [
      { gate: "structure", passed: true, detail: {} },
      { gate: "safety", passed: false, detail: { findings: [{ kind: "email", where: "body", match: "a@b.co" }], blocking: false } },
    ], sql);
    expect((await listContentItems(SITE, 50, sql)).find((i) => i.id === item!.id)).toMatchObject({ qa_failed: 0, qa_review: 1 });
    await insertQaResults(v.id, [{ gate: "mechanics", passed: false, detail: { problems: ["placeholder"] } }], sql);
    expect((await listContentItems(SITE, 50, sql)).find((i) => i.id === item!.id)).toMatchObject({ qa_failed: 1, qa_review: 1 });
  });

  it("names the customers no public fact names, and the internal facts, for the safety gate", async () => {
    const [named] = await sql<{ id: string }[]>`insert into context.entities (org_id, type, name, aliases) values (${ORG}, 'customer', 'Initech', '{Initech Corp}'), (${ORG}, 'customer', 'Globex Labs', '{}') returning id`;
    await sql`insert into context.brand_facts (org_id, type, subject_text, predicate, object_text, status, visibility, dedupe_key, verified_at) values
      (${ORG}, 'customer_proof', 'Globex Labs', 'cut onboarding time with', 'Acme SCIM', 'verified', 'public', 'p1', now()),
      (${ORG}, 'objection', 'Acme buyers', 'ask about', 'the SOC 2 bridge letter', 'verified', 'internal', 'i1', now()),
      (${ORG}, 'metric', 'Acme', 'is', 'fast', 'verified', 'internal', 'i2', now())`;
    expect(named).toBeTruthy();
    expect((await loadInternalTerms(ORG, sql)).sort()).toEqual(["Acme buyers ask about the SOC 2 bridge letter", "Initech", "Initech Corp"]);
  });
});
