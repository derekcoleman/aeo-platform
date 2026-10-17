import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerEngines, answerEngineSlug, answerSurface, type AnswerEngineConfig } from "@/lib/answers/engines";
import { probeAnswer, type ProbeResult } from "@/lib/answers/openrouter-probe";
import { recordAnswerObservation } from "@/lib/answers/record";
import { sampleAnswer } from "@/lib/answers/sample";
import { namedCompetitors } from "@/lib/app/strategy";
import { engineVisibility } from "@/lib/app/visibility";
import { ingestProfoundRecords } from "@/lib/connectors/profound";
import { citationGaps, loadSiteOwnership, type SiteOwnership } from "@/lib/demand/store";
import { ANSWER_PROBE_TASK_KEY, postgresSpendGovernor } from "@/lib/ops/spend";
import { postgresCache } from "@/lib/serp/cache";
import { fakeFetch } from "../helpers/fake-fetch";

/**
 * The answer ledger against the real schema: the native view never holds a
 * Profound row or a probe, the answer view keeps each tenant's own rows
 * through its security_invoker (as a member would read it), the backfill
 * labels old Profound rows once, and a probe goes in and comes out as the
 * Engines card counts it. Runs only with AEO_TEST_DATABASE_URL; everything it
 * creates is under throwaway organisations, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("answer ledger against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const ORG = randomUUID();
  const OTHER_ORG = randomUUID();
  const SITE = randomUUID();
  const OTHER_SITE = randomUUID();
  const TOPIC = randomUUID();
  const Q = { panel: randomUUID(), second: randomUUID(), other: randomUUID() };
  const CONN = randomUUID();
  const BRAND = randomUUID();
  const OKTA = randomUUID();
  const OWN = "acme-ledger.test";
  const RIVAL = "okta-ledger.test";
  const engines = Object.fromEntries(answerEngines({}).map((e) => [e.engine, e])) as Record<string, AnswerEngineConfig>;
  let own: SiteOwnership;

  const probe = (over: Partial<ProbeResult>): ProbeResult => ({
    engine: "chatgpt",
    requestedModel: "openai/gpt-5-mini",
    model: "openai/gpt-5-mini-2026-08",
    text: "",
    citations: [],
    citationSource: null,
    citationsObservable: false,
    finishReason: "stop",
    nativeFinishReason: null,
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 100, costUsd: 0.01 },
    upstreamProvider: null,
    responseId: null,
    fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...over,
  });
  const cite = (url: string, position: number) => ({ url, domain: new URL(url).hostname.replace(/^www\./, ""), title: null, snippet: null, position, positionInAnswer: position, source: "annotation" as const });

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Ledger test', ${`ledger-${ORG.slice(0, 8)}`}), (${OTHER_ORG}, 'Ledger other', ${`ledger-${OTHER_ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status) values
      (${SITE}, ${ORG}, 'Ledger test', ${OWN}, '/resources', ${`lg-${SITE.slice(0, 8)}.blogedge.test`}, 'active'),
      (${OTHER_SITE}, ${OTHER_ORG}, 'Ledger other', 'globex-ledger.test', '/blog', ${`lg-${OTHER_SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into measure.topics (id, site_id, name, slug, priority) values (${TOPIC}, ${SITE}, 'SSO', 'sso', 3)`;
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score, topic_id, is_tracked, tracking_tier) values
      (${Q.panel}, ${SITE}, 'best sso for startups', 'best sso for startups', 'manual', 'us-en', 'desktop', 50, ${TOPIC}, true, 'weekly'),
      (${Q.second}, ${SITE}, 'okta alternatives', 'okta alternatives', 'manual', 'us-en', 'desktop', 40, null, true, 'weekly'),
      (${Q.other}, ${OTHER_SITE}, 'globex pricing', 'globex pricing', 'manual', 'us-en', 'desktop', 10, null, true, 'weekly')`;
    await sql`insert into context.entities (id, org_id, type, name, aliases, domains) values
      (${BRAND}, ${ORG}, 'brand', 'Acme', ${sql.array([OWN])}, '{}'),
      (${OKTA}, ${ORG}, 'competitor', 'Okta', '{}', ${sql.array([RIVAL])})`;
    await sql`insert into context.context_connections (id, org_id, site_id, provider) values (${CONN}, ${ORG}, ${SITE}, 'profound')`;
    own = (await loadSiteOwnership(SITE, sql))!;
  });

  afterAll(async () => {
    await sql`delete from measure.serp_cache where method = 'answer' and query like ${`%${ORG}%`}`;
    await sql`delete from app.organizations where id in (${ORG}, ${OTHER_ORG})`;
    await sql.end();
  });

  it("the native view holds our SERP trackers' rows only; the answer view holds Profound's and the probes, with their topic", async () => {
    await sql`insert into measure.serp_snapshots (site_id, question_id, provider, locale, device, aio_triggered) values (${SITE}, ${Q.panel}, 'serpapi', 'us-en', 'desktop', true)`;
    await ingestProfoundRecords(own, { id: CONN, org_id: ORG, site_id: SITE } as never, [
      { prompt: "best sso for startups", engine: "chatgpt", date: new Date().toISOString().slice(0, 10), brandMentioned: true, citations: [{ url: `https://${RIVAL}/a`, domain: RIVAL, position: 1 }], visibility: 50, raw: { r: "1" } },
      { prompt: "best sso for startups", engine: "google_aio", date: new Date().toISOString().slice(0, 10), brandMentioned: false, citations: [{ url: `https://${RIVAL}/b`, domain: RIVAL, position: 1 }], visibility: 20, raw: { r: "2" } },
      { prompt: "best sso for startups", engine: "ai_mode", date: new Date().toISOString().slice(0, 10), brandMentioned: false, citations: [{ url: `https://${RIVAL}/c`, domain: RIVAL, position: 1 }], visibility: 10, raw: { r: "3" } },
    ], sql);
    await recordAnswerObservation(own, Q.panel, engines.perplexity!, probe({ engine: "perplexity", model: "perplexity/sonar", text: "Okta." }), { sampleIndex: 0, runId: "view-run", locale: "us-en", cached: false, costUsd: 0.01 }, sql);

    const native = await sql<{ provider: string }[]>`select provider::text from measure.v_native_aio where site_id = ${SITE}`;
    expect(native.map((r) => r.provider)).toEqual(["serpapi"]);
    const answers = await sql<{ provider: string; engine: string; collection_method: string; aio_triggered: boolean | null; topic_id: string | null; surfaces: string[] }[]>`
      select o.provider::text, o.engine, o.collection_method::text, o.aio_triggered, o.topic_id,
             coalesce((select array_agg(distinct c.surface::text) from measure.serp_citations c where c.serp_snapshot_id = o.id), '{}') as surfaces
      from measure.v_answer_observations o where o.site_id = ${SITE} order by o.provider::text, o.engine`;
    expect(answers).toEqual([
      { provider: "openrouter", engine: "perplexity", collection_method: "api_probe", aio_triggered: null, topic_id: TOPIC, surfaces: [] },
      { provider: "profound", engine: "ai_mode", collection_method: "third_party", aio_triggered: null, topic_id: TOPIC, surfaces: ["ai_mode"] },
      { provider: "profound", engine: "chatgpt", collection_method: "third_party", aio_triggered: null, topic_id: TOPIC, surfaces: ["llm_answer"] },
      { provider: "profound", engine: "google_aio", collection_method: "third_party", aio_triggered: true, topic_id: TOPIC, surfaces: ["ai_overview"] },
    ]);
    // Native reads never see them: no gap from a Profound AI Overview, and the native competitor count is zero.
    expect(await citationGaps(SITE, 10, sql)).toEqual([]);
    const okta = (await namedCompetitors(SITE, {}, sql)).find((c) => c.entity_id === OKTA)!;
    expect(okta.citations).toBe(0);
    expect((await namedCompetitors(SITE, { source: "profound" }, sql)).find((c) => c.entity_id === OKTA)!.citations).toBe(3);
  });

  it("a member reads only their own org's answers through both views", async () => {
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if; end $$`;
    await sql`grant usage on schema app, measure to app_user`;
    await sql`grant select on measure.serp_snapshots, measure.questions, measure.answer_mentions, measure.v_native_aio, measure.v_answer_observations to app_user`;
    await recordAnswerObservation((await loadSiteOwnership(OTHER_SITE, sql))!, Q.other, engines.chatgpt!, probe({ text: "Globex is cheap." }), { sampleIndex: 0, runId: "other-run", locale: "us-en", cached: false, costUsd: 0.01 }, sql);
    const seen = (orgIds: string[]) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ org_ids: orgIds })}, true)`;
        await tx`set local role app_user`;
        const [row] = await tx<{ mine: number; theirs: number; native_theirs: number }[]>`
          select (select count(*)::int from measure.v_answer_observations where site_id = ${SITE}) as mine,
                 (select count(*)::int from measure.v_answer_observations where site_id = ${OTHER_SITE}) as theirs,
                 (select count(*)::int from measure.v_native_aio where site_id = ${SITE}) as native_theirs`;
        return row!;
      });
    expect(await seen([ORG])).toEqual({ mine: 4, theirs: 0, native_theirs: 1 });
    expect(await seen([OTHER_ORG])).toEqual({ mine: 0, theirs: 1, native_theirs: 0 });
    expect(await seen([])).toEqual({ mine: 0, theirs: 0, native_theirs: 0 });
  });

  it("the backfill labels Profound rows stored before the ledger, and running it again changes nothing", async () => {
    // As 0004–0022 left them: every engine an AI Overview, every citation on ai_overview.
    const ids = await sql<{ id: string }[]>`
      select id from measure.serp_snapshots where site_id = ${SITE} and provider = 'profound'`;
    await sql`update measure.serp_snapshots set engine = 'google', aio_triggered = true where id = any (${ids.map((r) => r.id)}::uuid[])`;
    await sql`update measure.serp_citations set surface = 'ai_overview' where serp_snapshot_id = any (${ids.map((r) => r.id)}::uuid[])`;
    const [first] = await sql<{ snapshots: number; citations: number }[]>`select snapshots::int, citations::int from measure.backfill_answer_ledger(${SITE}::uuid)`;
    expect(first).toEqual({ snapshots: 3, citations: 2 });
    const rows = await sql<{ engine: string; aio_triggered: boolean | null; surface: string }[]>`
      select s.engine, s.aio_triggered, c.surface::text as surface
      from measure.serp_snapshots s join measure.serp_citations c on c.serp_snapshot_id = s.id
      where s.site_id = ${SITE} and s.provider = 'profound' order by s.engine`;
    expect(rows).toEqual([
      { engine: "ai_mode", aio_triggered: null, surface: "ai_mode" },
      { engine: "chatgpt", aio_triggered: null, surface: "llm_answer" },
      { engine: "google_aio", aio_triggered: true, surface: "ai_overview" },
    ]);
    const [again] = await sql<{ snapshots: number; citations: number }[]>`select snapshots::int, citations::int from measure.backfill_answer_ledger(${SITE}::uuid)`;
    expect(again).toEqual({ snapshots: 0, citations: 0 });
  });

  it("the SQL engine slug and surface rules agree with the TypeScript ones", async () => {
    const names = ["Google AI Overview", "chatgpt", "  _x__y_ ", "", "AI-Mode", "gemini"];
    const rows = await sql<{ slug: string }[]>`select measure.engine_slug(x) as slug from unnest(${names}::text[]) with ordinality as t(x, i) order by i`;
    expect(rows.map((r) => r.slug)).toEqual(names.map(answerEngineSlug));
    const engines = ["google_aio", "ai_mode", "chatgpt", "unknown"];
    const surfaces = await sql<{ s: string }[]>`select measure.answer_surface(x)::text as s from unnest(${engines}::text[]) with ordinality as t(x, i) order by i`;
    expect(surfaces.map((r) => r.s)).toEqual(engines.map(answerSurface));
  });

  it("records a probe with its sources and mentions once, and the Engines card counts it", async () => {
    const run = "visibility-run";
    const meta = (sampleIndex: number) => ({ sampleIndex, runId: run, locale: "us-en", cached: false, costUsd: 0.01 });
    const recommended = probe({
      text: "1. Okta is the enterprise default.\n2. Acme is ideal for startups.",
      citations: [cite(`https://www.${OWN}/resources/sso`, 1), cite(`https://${RIVAL}/sso`, 2), cite("https://www.reddit.com/r/sso", 3)],
      citationSource: "annotation",
      citationsObservable: true,
    });
    const first = await recordAnswerObservation(own, Q.panel, engines.chatgpt!, recommended, meta(0), sql);
    expect(first).toMatchObject({ duplicate: false, citations: 3, ownedCitations: 1, mentions: 2, brandMentioned: true, brandRecommended: true });
    // The same step again: found, not doubled.
    expect(await recordAnswerObservation(own, Q.panel, engines.chatgpt!, recommended, meta(0), sql)).toMatchObject({ snapshotId: first.snapshotId, duplicate: true });
    // A second answer that names nobody and exposes no sources.
    await recordAnswerObservation(own, Q.second, engines.chatgpt!, probe({ text: "It depends on your directory." }), meta(0), sql);

    const cites = await sql<{ domain: string; surface: string; source_role: string; entity_id: string | null; position_in_answer: number }[]>`
      select domain, surface::text, source_role::text, entity_id, position_in_answer from measure.serp_citations where serp_snapshot_id = ${first.snapshotId} order by position`;
    expect(cites).toEqual([
      { domain: OWN, surface: "llm_answer", source_role: "owned", entity_id: null, position_in_answer: 1 },
      { domain: RIVAL, surface: "llm_answer", source_role: "competitor", entity_id: OKTA, position_in_answer: 2 },
      { domain: "reddit.com", surface: "llm_answer", source_role: "ugc_forum", entity_id: null, position_in_answer: 3 },
    ]);
    const mentions = await sql<{ entity_id: string; org_id: string; is_brand: boolean; list_rank: number; is_recommended: boolean }[]>`
      select entity_id, org_id, is_brand, list_rank, is_recommended from measure.answer_mentions where snapshot_id = ${first.snapshotId} order by list_rank`;
    expect(mentions).toEqual([
      { entity_id: OKTA, org_id: ORG, is_brand: false, list_rank: 1, is_recommended: true },
      { entity_id: BRAND, org_id: ORG, is_brand: true, list_rank: 2, is_recommended: true },
    ]);

    const report = await engineVisibility(SITE, { days: 28 }, sql);
    const chat = report.engines.find((e) => e.engine === "chatgpt")!;
    expect(chat).toMatchObject({ n: 2, nObservable: 1, lowN: true, modelVersions: ["openai/gpt-5-mini-2026-08+web:native"] });
    expect([chat.mention.k, chat.recommendation.k, chat.citation.k, chat.citation.n]).toEqual([1, 1, 1, 1]);
    expect(chat.competitors.map((c) => [c.name, c.recommendation.k, c.recommendation.n])).toEqual([["Okta", 1, 2]]);
    // The earlier Perplexity probe, and nothing from Profound or the native tracker.
    expect(report.engines.map((e) => e.engine)).toEqual(["chatgpt", "perplexity"]);
    // A topic filter keeps the topic's prompts only.
    expect((await engineVisibility(SITE, { topicId: TOPIC }, sql)).engines.find((e) => e.engine === "chatgpt")!.n).toBe(1);
  });

  it("an answer carrying NUL or half a surrogate pair is cached and recorded, and paid for once", async () => {
    const f = fakeFetch({
      "https://or.test/api/v1/chat/completions": {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5-mini-2026-08",
          choices: [{
            finish_reason: "stop",
            message: {
              content: "1. Acme\u0000 is ideal for startups \ud83d.",
              annotations: [{ type: "url_citation", url_citation: { url: `https://${OWN}/resources/sso`, title: "Ac\u0000me", content: "SSO \udc00 for teams", start_index: 0 } }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 100, cost: 0.01 },
        }),
      },
    });
    let probes = 0;
    const deps = {
      sql,
      cache: postgresCache(sql),
      governor: postgresSpendGovernor(sql, { env: {}, onAlert: async () => undefined }),
      probe: (cfg: AnswerEngineConfig, prompt: string) => (probes++, probeAnswer(cfg, prompt, { apiKey: "k", baseUrl: "https://or.test/api/v1", fetchImpl: f.fetchImpl })),
    };
    const question = { id: Q.second, text: `storable answer ${ORG}`, locale: "us-en", device: "desktop" as const };
    const first = await sampleAnswer({ own, question, engine: engines.chatgpt!, sampleIndex: 0, runId: "storable-run", day: "2026-10-13" }, deps);
    expect(first).toMatchObject({ duplicate: false, cached: false, costUsd: 0.01, citations: 1, ownedCitations: 1, brandMentioned: true });
    // Another run the same day reads the cached answer back: Postgres took it.
    expect(await sampleAnswer({ own, question, engine: engines.chatgpt!, sampleIndex: 0, runId: "storable-run-2", day: "2026-10-13" }, deps)).toMatchObject({ duplicate: false, cached: true, costUsd: 0 });
    expect(probes).toBe(1);

    const [snap] = await sql<{ answer_text: string; title: string; snippet: string }[]>`
      select s.answer_text, c.title, c.snippet from measure.serp_snapshots s join measure.serp_citations c on c.serp_snapshot_id = s.id where s.id = ${first.snapshotId}`;
    expect(snap).toEqual({ answer_text: "1. Acme is ideal for startups \ufffd.", title: "Acme", snippet: "SSO \ufffd for teams" });
    const [spend] = await sql<{ calls: number; spent: number }[]>`
      select (select count(*)::int from ops.llm_calls where org_id = ${ORG} and task_key = ${ANSWER_PROBE_TASK_KEY}) as calls,
             (select sum(c.spent_usd)::float from ops.spend_counters c join ops.budgets b on b.id = c.budget_id
              where b.org_id = ${ORG} and b.resource = 'answer_probe') as spent`;
    expect(spend).toEqual({ calls: 1, spent: 0.01 });
  });
});
