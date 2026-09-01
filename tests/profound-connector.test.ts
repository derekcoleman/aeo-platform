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
    const c = ctx(true, [
      [/from app\.sites where id/, () => [{ id: conn.site_id, org_id: conn.org_id, canonical_domain: "www.acme.com", path_prefix: "/resources" }]],
      [/from app\.site_domains/, () => []],
      [/insert into measure\.questions/, () => [{ id: nextId(), inserted: true }]],
      [/insert into measure\.serp_snapshots/, () => [{ id: nextId() }]],
      [/insert into measure\.external_metrics/, (q) => [{ id: nextId() }].slice(0, q.values.length > 0 ? 1 : 0)],
      [/from content\.content_items/, () => []],
    ]);
    const r = await profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { csv, filename: "export.csv" } }, c);
    expect(r.detail).toMatchObject({ questionsInserted: 1, questionsMatched: 0, snapshots: 2, citations: 3, ownedCitations: 1, rows: 2, skipped: [] });
    expect(r.cursor).toMatchObject({ through: "2026-08-21", lastFile: "export.csv" });

    const q = c.sql.queries;
    expect(q.filter((x) => /insert into measure\.questions/.test(x.text))).toHaveLength(1);
    const snaps = q.filter((x) => /insert into measure\.serp_snapshots/.test(x.text));
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.values[2]).toBe("profound");
    const cites = q.filter((x) => /insert into measure\.serp_citations/.test(x.text));
    expect(cites).toHaveLength(3);
    expect(cites.map((x) => [x.values[4], x.values[6]])).toEqual([
      ["acme.com", true],
      ["rival.com", false],
      ["rival.com", false],
    ]);
    const metrics = q.filter((x) => /insert into measure\.external_metrics/.test(x.text));
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.every((x) => x.values.includes("profound"))).toBe(true);
  });

  it("rejects a malformed upload payload", async () => {
    await expect(profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { nope: 1 } }, ctx(true))).rejects.toThrow();
    await expect(profoundConnector.sync({ connection: conn, kind: "upload", cursor: null, payload: { csv: "Prompt\nx" } }, ctx(true))).rejects.toThrow(/missing required column/);
    expect(new ConnectorError("profound", "x").name).toBe("ConnectorError");
  });
});
