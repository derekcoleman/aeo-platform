import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profoundConnector } from "@/lib/connectors/profound";
import { getConnection, setFeature } from "@/lib/connectors/store";
import { connectionSecretRef, memorySecrets } from "@/lib/secrets/vault";
import type { ConnectorContext } from "@/lib/connectors/types";

/**
 * Runs only with AEO_TEST_DATABASE_URL pointing at a database carrying every
 * migration (CI's `database` job; locally `psql` the migrations into one).
 * Everything it creates is under one throwaway organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

const PROMPTS = 189;
const ENGINES = ["chatgpt", "perplexity", "google_aio", "gemini", "copilot"];
const TODAY = "2026-09-17";
const day = (iso: string, plus: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

describe.skipIf(!DB_URL)("profound paged backfill against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const CONN = randomUUID();
  let calls: { start: string; end: string; offset: number }[] = [];

  /** A Profound that answers any range with PROMPTS × ENGINES rows per day, paged by offset. */
  const fakeFetch = (async (_url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { start_date: string; end_date: string; pagination: { limit: number; offset: number } };
    const start = body.start_date.slice(0, 10);
    const end = body.end_date.slice(0, 10);
    const { limit, offset } = body.pagination;
    calls.push({ start, end, offset });
    const perDay = PROMPTS * ENGINES.length;
    const total = perDay * daysBetween(start, end);
    const data = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      const d = Math.floor(i / perDay);
      const p = Math.floor((i % perDay) / ENGINES.length);
      const e = i % ENGINES.length;
      data.push({
        prompt: `How do I edit video ${p}`,
        prompt_id: `p${p}`,
        model: { name: ENGINES[e] },
        created_at: `${day(start, d)}T10:00:00Z`,
        asset: "Acme",
        mentions: i % 3 ? ["Acme"] : [],
        region: "us",
        topic: "editing",
        citation_details: [
          { url: `https://acme.com/resources/guide-${i % 7}`, clean_url: `acme.com/resources/guide-${i % 7}`, hostname: "acme.com", positions: [1] },
          { url: `https://rival.com/blog/${i % 11}`, clean_url: `rival.com/blog/${i % 11}`, hostname: "rival.com", positions: [2] },
          { url: `https://g2.com/x/${i % 5}`, clean_url: `g2.com/x/${i % 5}`, hostname: "g2.com", positions: [3] },
        ],
      });
    }
    return new Response(JSON.stringify({ info: { total_rows: total }, data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  async function ctx(): Promise<ConnectorContext> {
    const secrets = memorySecrets();
    await secrets.put(connectionSecretRef(CONN), "test-key", "test");
    return { sql, secrets, fetchImpl: fakeFetch, now: () => new Date(`${TODAY}T12:00:00Z`), env: { NODE_ENV: "test" } as NodeJS.ProcessEnv };
  }

  async function counts() {
    const [s] = await sql<{ n: number }[]>`select count(*)::int as n from measure.serp_snapshots where site_id = ${SITE} and provider = 'profound'`;
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from measure.serp_citations ci join measure.serp_snapshots s on s.id = ci.serp_snapshot_id where s.site_id = ${SITE} and s.provider = 'profound'`;
    const [o] = await sql<{ n: number }[]>`select count(*)::int as n from measure.serp_citations ci join measure.serp_snapshots s on s.id = ci.serp_snapshot_id where s.site_id = ${SITE} and s.provider = 'profound' and ci.is_owned`;
    const [q] = await sql<{ n: number }[]>`select count(*)::int as n from measure.questions where site_id = ${SITE} and source = 'profound'`;
    const [m] = await sql<{ n: number }[]>`select count(*)::int as n from measure.external_metrics where site_id = ${SITE} and provider = 'profound'`;
    return { snapshots: s!.n, citations: c!.n, owned: o!.n, questions: q!.n, metrics: m!.n };
  }

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Backfill test', ${`backfill-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status, proxy_hmac_secret)
      values (${SITE}, ${ORG}, 'Backfill test', 'acme.com', '/resources', ${`bf-${SITE.slice(0, 8)}.blogedge.test`}, 'active', 'secret')`;
    await sql`insert into context.context_connections (id, org_id, site_id, provider, status, secret_ref, config)
      values (${CONN}, ${ORG}, ${SITE}, 'profound', 'active', ${connectionSecretRef(CONN)}, ${sql.json({ mode: "api", categoryId: "c1", backfillDays: 40 })})`;
    await setFeature(ORG, "connector:profound", true, sql);
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  it("walks a 40-day backfill in 30-day windows of 2,000-row pages, idempotently", async () => {
    // Rows left by earlier killed attempts, doubled: they must vanish with the range.
    const [q] = await sql<{ id: string }[]>`insert into measure.questions (site_id, text, normalized, source, seed_term, depth, locale, device, demand_score, seen_count)
      values (${SITE}, 'stale prompt', 'stale prompt', 'profound', 'x', 1, 'us-en', 'desktop', 1, 1) returning id`;
    await sql`insert into measure.serp_snapshots (site_id, question_id, provider, fetched_at, locale, device, raw)
      values (${SITE}, ${q!.id}, 'profound', '2026-09-01T00:00:00Z', 'us-en', 'desktop', '{"engine":"chatgpt"}'), (${SITE}, ${q!.id}, 'profound', '2026-09-01T00:00:00Z', 'us-en', 'desktop', '{"engine":"chatgpt"}')`;
    expect((await counts()).snapshots).toBe(2);

    const conn = (await getConnection(CONN, sql))!;
    const c = await ctx();
    const first = await profoundConnector.syncPage!({ connection: conn as never, kind: "backfill", cursor: null, payload: undefined, page: null }, c);
    expect(first.next).toEqual({ rangeStart: "2026-08-08", rangeEnd: TODAY, start: "2026-08-08", end: "2026-09-06", offset: 2000 });
    expect(first.detail).toMatchObject({ rows: 2000, snapshots: 2000, citations: 6000, questionsInserted: PROMPTS });
    expect(await counts()).toEqual({ snapshots: 2000, citations: 6000, owned: 2000, questions: PROMPTS + 1, metrics: 2000 });

    calls = [];
    const r = await profoundConnector.sync({ connection: conn as never, kind: "backfill", cursor: null, payload: undefined }, c);
    const expectedRows = PROMPTS * ENGINES.length * daysBetween("2026-08-08", TODAY);
    expect(r.cursor).toEqual({ through: TODAY });
    expect(r.detail).toMatchObject({ rows: expectedRows, snapshots: expectedRows, pages: calls.length });
    expect([...new Set(calls.map((x) => `${x.start}..${x.end}`))]).toEqual(["2026-08-08..2026-09-06", "2026-09-07..2026-09-17"]);
    const after = await counts();
    expect(after).toEqual({ snapshots: expectedRows, citations: expectedRows * 3, owned: expectedRows, questions: PROMPTS + 1, metrics: expectedRows });

    // Running the whole thing again changes nothing.
    await profoundConnector.sync({ connection: conn as never, kind: "backfill", cursor: null, payload: undefined }, c);
    expect(await counts()).toEqual(after);

    // Replaying one page in the middle (a step whose result was lost) replaces its own tuples only.
    const mid = { rangeStart: "2026-08-08", rangeEnd: TODAY, start: "2026-08-08", end: "2026-09-06", offset: 4000 };
    const mr = await profoundConnector.syncPage!({ connection: conn as never, kind: "backfill", cursor: null, payload: undefined, page: mid }, c);
    expect(mr.detail).toMatchObject({ rows: 2000 });
    expect(await counts()).toEqual(after);

    // An incremental run covers only the days since its cursor.
    calls = [];
    const inc = await profoundConnector.sync({ connection: conn as never, kind: "incremental", cursor: { through: "2026-09-15" }, payload: undefined }, c);
    expect([...new Set(calls.map((x) => `${x.start}..${x.end}`))]).toEqual(["2026-09-15..2026-09-17"]);
    expect(inc.detail).toMatchObject({ rows: PROMPTS * ENGINES.length * 3 });
    expect(await counts()).toEqual(after);
  }, 300_000);
});
