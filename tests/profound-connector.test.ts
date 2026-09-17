import { describe, expect, it } from "vitest";
import {
  PROFOUND_FEATURE,
  mapHeaders,
  normalizeEngine,
  parseBool,
  parseCitations,
  parseCsv,
  parseDate,
  parseProfoundCsv,
  profoundConnector,
  type ProfoundConfig,
} from "@/lib/connectors/profound";
import { ConnectorError, FeatureDisabledError, type ConnectionRow, type ConnectorContext } from "@/lib/connectors/types";
import { memorySecrets } from "@/lib/secrets/vault";
import { fakeSql, idSequence, type FakeSqlHandler } from "./helpers/fake-sql";

describe("parseCsv", () => {
  it("handles quoting, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"multi\nline",z\n\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'he said "hi"'],
      ["2", "multi\nline", "z"],
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });
});

describe("field parsers", () => {
  it("maps header aliases case- and separator-insensitively", () => {
    expect(mapHeaders(["Prompt Text", "AI_Engine", "Run-Date", "Brand Mentioned", "Visibility %", "Cited URLs"])).toEqual({
      prompt: 0,
      engine: 1,
      date: 2,
      brandMentioned: 3,
      visibility: 4,
      citations: 5,
    });
  });

  it("parseDate accepts ISO, timestamps and US dates", () => {
    expect(parseDate("2026-08-20")).toBe("2026-08-20");
    expect(parseDate("2026-08-20T13:00:00Z")).toBe("2026-08-20");
    expect(parseDate("8/5/2026")).toBe("2026-08-05");
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  it("parseBool and normalizeEngine tolerate export vocabulary", () => {
    expect(parseBool("Mentioned")).toBe(true);
    expect(parseBool("not mentioned")).toBe(false);
    expect(parseBool("maybe")).toBeNull();
    expect(normalizeEngine("ChatGPT (GPT-4o)")).toBe("chatgpt");
    expect(normalizeEngine("Google AI Overviews")).toBe("google_aio");
    expect(normalizeEngine("Microsoft Copilot")).toBe("copilot");
    expect(normalizeEngine("")).toBe("unknown");
    expect(normalizeEngine("Some New Engine")).toBe("some_new_engine");
  });

  it("parseCitations splits lists, dedupes, and keeps export positions when given", () => {
    const cites = parseCitations("https://acme.com/resources/sso; https://www.rival.com/blog | https://acme.com/resources/sso\n[https://g2.com/x]");
    expect(cites).toEqual([
      { url: "https://acme.com/resources/sso", domain: "acme.com", position: 1 },
      { url: "https://www.rival.com/blog", domain: "rival.com", position: 2 },
      { url: "https://g2.com/x", domain: "g2.com", position: 3 },
    ]);
    expect(parseCitations("https://a.com/1 https://b.com/2", "4, 9")[1]).toMatchObject({ domain: "b.com", position: 9 });
    expect(parseCitations("just text")).toEqual([]);
    expect(parseCitations(undefined)).toEqual([]);
  });
});

describe("parseProfoundCsv", () => {
  it("normalises rows and reports skipped ones with line numbers", () => {
    const csv = [
      "Prompt,Platform,Date,Brand Mentioned,Visibility,Sources",
      "best sso for mid-market,ChatGPT,2026-08-20,Yes,42%,https://acme.com/resources/sso;https://rival.com/x",
      ",ChatGPT,2026-08-20,No,0,",
      "okta vs entra,Perplexity,garbage,No,,",
    ].join("\n");
    const r = parseProfoundCsv(csv);
    expect(r.columns).toEqual(["Prompt", "Platform", "Date", "Brand Mentioned", "Visibility", "Sources"]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ prompt: "best sso for mid-market", engine: "chatgpt", date: "2026-08-20", brandMentioned: true, visibility: 42 });
    expect(r.records[0]!.citations.map((c) => c.domain)).toEqual(["acme.com", "rival.com"]);
    expect(r.skipped).toEqual([
      { line: 3, reason: "empty prompt" },
      { line: 4, reason: 'unparseable date "garbage"' },
    ]);
  });

  it("names the missing required columns", () => {
    expect(() => parseProfoundCsv("Prompt,Visibility\nx,1")).toThrow(/missing required column\(s\): engine, date/);
  });
});

describe("profoundConnector", () => {
  const conn: ConnectionRow<ProfoundConfig> = {
    id: "cccccccc-0000-0000-0000-000000000003",
    org_id: "11111111-1111-1111-1111-111111111111",
    site_id: "aaaaaaaa-0000-0000-0000-000000000001",
    provider: "profound",
    status: "active",
    enabled: true,
    config: { plan: "growth" },
    scope: [],
    secret_ref: null,
    external_account_id: null,
    external_account_name: null,
    last_synced_at: null,
    last_error: null,
  };

  function ctx(enabled: boolean, extra: [RegExp, FakeSqlHandler][] = []): ConnectorContext & { sql: ReturnType<typeof fakeSql> } {
    const sql = fakeSql([[/app\.org_feature_enabled/, (q) => [{ enabled: enabled && q.values[1] === PROFOUND_FEATURE }]], ...extra]);
    return { sql, secrets: memorySecrets(), fetchImpl: fetch, now: () => new Date("2026-09-01T00:00:00Z"), env: { NODE_ENV: "test" } };
  }

  const csv = "Prompt,Engine,Date,Brand Mentioned,Visibility,Citations\nbest sso for mid-market,ChatGPT,2026-08-20,yes,42,https://acme.com/resources/sso;https://rival.com/x\nbest sso for mid-market,Perplexity,2026-08-21,no,10,https://rival.com/y";

  it("refuses to sync or validate when the org feature flag is off — Profound is never a dependency", async () => {
    const c = ctx(false);
    await expect(profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { csv } }, c)).rejects.toBeInstanceOf(FeatureDisabledError);
    await expect(profoundConnector.validate!(conn, c)).rejects.toBeInstanceOf(FeatureDisabledError);
    expect(c.sql.queries.every((q) => /org_feature_enabled/.test(q.text))).toBe(true);
  });

  it("requires a site scope", async () => {
    await expect(profoundConnector.validate!({ ...conn, site_id: null }, ctx(true))).rejects.toMatchObject({ code: "site_required" });
  });

  it("treats non-upload kinds as a no-op rather than a failure on the CSV path", async () => {
    const r = await profoundConnector.sync({ connection: conn, kind: "incremental", cursor: { through: "2026-08-01" } }, ctx(true));
    expect(r).toMatchObject({ documentsIngested: 0, metricsIngested: 0, cursor: { through: "2026-08-01" }, detail: { skipped: "kind incremental unsupported on csv path" } });
  });

  it("ingests an upload into questions / snapshots / citations / external_metrics with provider attribution", async () => {
    const nextId = idSequence();
    type Rows<T> = { __rows: T[] };
    const c = ctx(true, [
      [/from app\.sites where id/, () => [{ id: conn.site_id, org_id: conn.org_id, canonical_domain: "www.acme.com", path_prefix: "/resources" }]],
      [/from app\.site_domains/, () => []],
      [/insert into measure\.questions/, (q) => (q.values[0] as Rows<{ normalized: string }>).__rows.map((r) => ({ id: nextId(), normalized: r.normalized, inserted: true }))],
      [/insert into measure\.external_metrics/, (q) => (q.values[0] as Rows<unknown>).__rows.map(() => ({ id: nextId() }))],
      [/from content\.content_items/, () => []],
    ]);
    const r = await profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { csv, filename: "export.csv" } }, c);
    expect(r.detail).toMatchObject({ questionsInserted: 1, questionsMatched: 0, snapshots: 2, citations: 3, ownedCitations: 1, metrics: 2, rows: 2, skipped: [] });
    expect(r.cursor).toMatchObject({ through: "2026-08-21", lastFile: "export.csv" });

    // Everything lands in bulk: one statement per table, rows carried by the helper.
    const q = c.sql.queries;
    expect(q.filter((x) => /insert into measure\.questions/.test(x.text))).toHaveLength(1);
    const snaps = q.filter((x) => /insert into measure\.serp_snapshots/.test(x.text));
    expect(snaps).toHaveLength(1);
    const snapRows = (snaps[0]!.values[0] as Rows<{ provider: string; fetched_at: string; raw: { __json: { engine: string } } }>).__rows;
    expect(snapRows).toHaveLength(2);
    expect(snapRows.map((x) => [x.provider, x.fetched_at, x.raw.__json.engine])).toEqual([
      ["profound", "2026-08-20T00:00:00.000Z", "chatgpt"],
      ["profound", "2026-08-21T00:00:00.000Z", "perplexity"],
    ]);
    // The same tuples are removed before the insert, so a replayed page cannot double them.
    const wipe = q.find((x) => /delete from measure\.serp_snapshots s using unnest/.test(x.text))!;
    expect(wipe).toBeDefined();
    expect((wipe.values[2] as { __array: string[] }).__array).toEqual(["chatgpt", "perplexity"]);
    const cites = q.filter((x) => /insert into measure\.serp_citations/.test(x.text));
    expect(cites).toHaveLength(1);
    const citeRows = (cites[0]!.values[0] as Rows<{ domain: string; is_owned: boolean; serp_snapshot_id: string }>).__rows;
    expect(citeRows.map((x) => [x.domain, x.is_owned])).toEqual([
      ["acme.com", true],
      ["rival.com", false],
      ["rival.com", false],
    ]);
    expect(new Set(citeRows.map((x) => x.serp_snapshot_id))).toEqual(new Set(snapRows.map((x) => (x as unknown as { id: string }).id)));
    const metrics = q.filter((x) => /insert into measure\.external_metrics/.test(x.text));
    expect(metrics).toHaveLength(1);
    expect((metrics[0]!.values[0] as Rows<{ provider: string }>).__rows.every((x) => x.provider === "profound")).toBe(true);
  });

  it("rejects a malformed upload payload", async () => {
    await expect(profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { nope: 1 } }, ctx(true))).rejects.toThrow();
    await expect(profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { csv: "Prompt\nx" } }, ctx(true))).rejects.toThrow(/missing required column/);
    expect(new ConnectorError("profound", "x").name).toBe("ConnectorError");
  });
});

describe("backfill windows", () => {
  it("walks a long backfill in fixed windows and stops at today", async () => {
    const { backfillWindow, BACKFILL_WINDOW_DAYS } = await import("@/lib/connectors/profound");
    expect(BACKFILL_WINDOW_DAYS).toBe(30);
    expect(backfillWindow("2026-06-17", "2026-09-15")).toEqual({ start: "2026-06-17", end: "2026-07-16", next: "2026-07-17" });
    expect(backfillWindow("2026-07-17", "2026-09-15")).toEqual({ start: "2026-07-17", end: "2026-08-15", next: "2026-08-16" });
    expect(backfillWindow("2026-08-16", "2026-09-15")).toEqual({ start: "2026-08-16", end: "2026-09-14", next: "2026-09-15" });
    expect(backfillWindow("2026-09-15", "2026-09-15")).toEqual({ start: "2026-09-15", end: "2026-09-15", next: null });
    expect(backfillWindow("2026-09-20", "2026-09-15")).toEqual({ start: "2026-09-15", end: "2026-09-15", next: null });
    expect(backfillWindow("2026-09-10", "2026-09-15", 7)).toEqual({ start: "2026-09-10", end: "2026-09-15", next: null });
  });

  it("only resumes from a well-formed date in the payload", async () => {
    const { backfillResumeFrom } = await import("@/lib/connectors/profound");
    expect(backfillResumeFrom({ from: "2026-07-17" })).toBe("2026-07-17");
    expect(backfillResumeFrom({ from: "yesterday" })).toBeNull();
    expect(backfillResumeFrom({ csv: "x" })).toBeNull();
    expect(backfillResumeFrom(undefined)).toBeNull();
  });
});

describe("paged API sync", () => {
  const apiConn: ConnectionRow<ProfoundConfig> = {
    id: "cccccccc-0000-0000-0000-000000000002",
    org_id: "11111111-1111-1111-1111-111111111111",
    site_id: "22222222-2222-2222-2222-222222222222",
    provider: "profound",
    status: "active",
    enabled: true,
    config: { mode: "api", categoryId: "cat1", backfillDays: 40 },
    scope: [],
    secret_ref: "vault:connection:cccccccc-0000-0000-0000-000000000002",
    external_account_id: null,
    external_account_name: null,
    last_synced_at: null,
    last_error: null,
  };

  function pagedCtx(pages: Record<string, unknown>[][], total: number) {
    const calls: { start: string; end: string; offset: number }[] = [];
    const fetchImpl = (async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { start_date: string; end_date: string; pagination: { offset: number } };
      calls.push({ start: body.start_date.slice(0, 10), end: body.end_date.slice(0, 10), offset: body.pagination.offset });
      const page = pages[calls.length - 1] ?? [];
      return new Response(JSON.stringify({ info: { total_rows: total }, data: page }), { status: 200 });
    }) as unknown as typeof fetch;
    const next = idSequence();
    const sql = fakeSql([
      [/org_feature_enabled/, () => [{ enabled: true }]],
      [/select id, org_id, canonical_domain, path_prefix from app\.sites/, () => [{ id: apiConn.site_id, org_id: apiConn.org_id, canonical_domain: "acme.com", path_prefix: "/resources" }]],
      [/insert into measure\.questions/, (q) => ((q.values[0] as { __rows: { normalized: string }[] }).__rows).map((r) => ({ id: next(), normalized: r.normalized, inserted: true }))],
      [/insert into measure\.external_metrics/, (q) => ((q.values[0] as { __rows: unknown[] }).__rows).map(() => ({ id: next() }))],
    ]);
    const secrets = memorySecrets();
    secrets.store.set(apiConn.secret_ref!, "key");
    const ctx: ConnectorContext = { sql, secrets, fetchImpl, now: () => new Date("2026-09-17T12:00:00Z"), env: { NODE_ENV: "test" } as NodeJS.ProcessEnv };
    return { ctx, sql, calls };
  }

  const row = (i: number, day: string) => ({ prompt: `prompt ${i}`, model: { name: "chatgpt" }, created_at: `${day}T10:00:00Z`, asset: "Acme", mentions: ["Acme"], citation_details: [{ url: `https://acme.com/resources/g${i}`, hostname: "acme.com", positions: [1] }] });

  it("only API connections and non-upload kinds take the paged path", () => {
    expect(profoundConnector.pagesSync!(apiConn, "backfill")).toBe(true);
    expect(profoundConnector.pagesSync!(apiConn, "upload")).toBe(false);
    expect(profoundConnector.pagesSync!({ ...apiConn, config: { mode: "csv" } }, "incremental")).toBe(false);
  });

  it("the first page fixes the range, clears it, and hands back a page token; the last page hands back the cursor", async () => {
    const { ctx, sql, calls } = pagedCtx([[row(1, "2026-08-08"), row(2, "2026-08-08")], []], 2);
    const first = await profoundConnector.syncPage!({ connection: apiConn, kind: "backfill", cursor: null, page: null }, ctx);
    expect(calls[0]).toEqual({ start: "2026-08-08", end: "2026-09-06", offset: 0 });
    expect(sql.queries.some((q) => /delete from measure\.serp_snapshots where site_id = \$1 and provider = 'profound' and fetched_at >= \$2 and fetched_at < \$3/.test(q.text) && q.values[1] === "2026-08-08T00:00:00.000Z" && q.values[2] === "2026-09-18T00:00:00.000Z")).toBe(true);
    expect(sql.queries.some((q) => /delete from measure\.serp_snapshots s using unnest/.test(q.text))).toBe(true);
    expect(sql.queries.filter((q) => /insert into measure\.serp_snapshots/.test(q.text)).length).toBe(1);
    expect(sql.queries.filter((q) => /insert into measure\.serp_citations/.test(q.text)).length).toBe(1);
    expect(first.metricsIngested).toBe(2);
    // A short page (2 < 2000) ends the first window; the next window starts the day after it.
    expect(first.next).toEqual({ rangeStart: "2026-08-08", rangeEnd: "2026-09-17", start: "2026-09-07", end: "2026-09-17", offset: 0 });
    expect(first.cursor).toBeNull();
    expect(first.detail).toMatchObject({ rows: 2, snapshots: 2, citations: 1 * 2, ownedCitations: 2, window: { start: "2026-08-08", end: "2026-09-17" } });

    const last = await profoundConnector.syncPage!({ connection: apiConn, kind: "backfill", cursor: null, page: first.next }, ctx);
    expect(calls[1]).toEqual({ start: "2026-09-07", end: "2026-09-17", offset: 0 });
    expect(last.next).toBeNull();
    expect(last.cursor).toEqual({ through: "2026-09-17" });
    // The range was cleared once, on the first page only.
    expect(sql.queries.filter((q) => /delete from measure\.serp_snapshots where site_id/.test(q.text)).length).toBe(1);
  });

  it("an incremental run starts at the cursor and a bad page token starts over", async () => {
    const { ctx, calls } = pagedCtx([[]], 0);
    const r = await profoundConnector.syncPage!({ connection: apiConn, kind: "incremental", cursor: { through: "2026-09-10" }, page: { garbage: true } }, ctx);
    expect(calls[0]).toEqual({ start: "2026-09-10", end: "2026-09-17", offset: 0 });
    expect(r.next).toBeNull();
    expect(r.cursor).toEqual({ through: "2026-09-17" });
  });
});
