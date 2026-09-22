import { describe, expect, it } from "vitest";
import { assertNoSecretsInConfig, errorMessage, recordWebhookEvent, upsertDocuments, withSyncRun } from "@/lib/connectors/store";
import { ConnectorError } from "@/lib/connectors/types";
import { fakeSql, idSequence } from "./helpers/fake-sql";

const conn = { id: "cccccccc-0000-0000-0000-000000000001", org_id: "11111111-1111-1111-1111-111111111111", site_id: null, provider: "slack" as const, secret_ref: "vault:connection:x" };

describe("assertNoSecretsInConfig", () => {
  it("accepts ordinary config", () => {
    expect(() => assertNoSecretsInConfig({ teamId: "T1", channels: [{ id: "C1", name: "general" }], nested: { propertyId: "123" } })).not.toThrow();
  });
  it("rejects secret-looking keys and token-shaped values, including nested", () => {
    expect(() => assertNoSecretsInConfig({ token: "abc" })).toThrow(/Vault/);
    expect(() => assertNoSecretsInConfig({ apiKey: "abc" })).toThrow(/Vault/);
    expect(() => assertNoSecretsInConfig({ note: "xoxb-not-a-real-token-abcdefghijklmnopqrstuvwxyz" })).toThrow(/credential/);
    expect(() => assertNoSecretsInConfig({ google: { refresh: "1//0abcdefghijklmnopqrstuvwxyz0123456789" } })).toThrow(/config\.google\.refresh/);
  });
});

describe("errorMessage", () => {
  it("redacts tokens that leaked into an error string", () => {
    const m = errorMessage(new Error("slack said no for xoxb-fake-abc with Bearer ya29.secret"));
    expect(m).not.toContain("xoxb-");
    expect(m).not.toContain("ya29.");
    expect(m).toContain("[redacted]");
    expect(m.startsWith("Error:")).toBe(true);
  });
  it("stringifies non-errors and caps length", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage("x".repeat(5000)).length).toBe(1000);
  });
});

describe("withSyncRun", () => {
  it("records a succeeded run with counts and cursor", async () => {
    const next = idSequence();
    const sql = fakeSql([[/insert into context\.context_sync_runs/, () => [{ id: next() }]]]);
    const out = await withSyncRun(conn, "incremental", async (run) => {
      expect(run.kind).toBe("incremental");
      return { documentsIngested: 3, metricsIngested: 0, cursor: { C1: "1.2" } };
    }, sql);
    expect(out.documentsIngested).toBe(3);
    const texts = sql.queries.map((q) => q.text);
    expect(texts.some((t) => t.includes("status = 'succeeded'"))).toBe(true);
    expect(texts.some((t) => t.includes("last_error = null, status = 'active'"))).toBe(true);
  });

  it("writes a failed run with the redacted error, flags the connection, and rethrows", async () => {
    const sql = fakeSql([[/insert into context\.context_sync_runs/, () => [{ id: "run-1" }]]]);
    const boom = new ConnectorError("slack", "auth", "invalid_auth for xoxb-leaked-token");
    await expect(withSyncRun(conn, "backfill", async () => { throw boom; }, sql)).rejects.toBe(boom);
    const failed = sql.queries.find((q) => q.text.includes("status = 'failed'"));
    expect(failed).toBeDefined();
    expect(String(failed!.values[0])).toContain("[redacted]");
    expect(String(failed!.values[0])).not.toContain("xoxb-leaked");
    expect(sql.queries.some((q) => q.text.includes("status = 'error'"))).toBe(true);
  });
});

describe("upsertDocuments", () => {
  it("skips blank documents and counts only rows the database returned", async () => {
    const sql = fakeSql([[/insert into context\.context_documents/, (q) => (String(q.values[5]).endsWith(":dup") ? [] : [{ id: "d" }])]]);
    const n = await upsertDocuments(conn, [
      { kind: "slack_message", externalId: "C1:1", title: null, text: "hello", metadata: {}, sourceTs: new Date(0), siteId: null },
      { kind: "slack_message", externalId: "C1:dup", title: null, text: "unchanged", metadata: {}, sourceTs: new Date(0), siteId: null },
      { kind: "slack_message", externalId: "C1:blank", title: null, text: "   ", metadata: {}, sourceTs: new Date(0), siteId: null },
    ], { retentionDays: 30 }, sql);
    expect(n).toBe(1);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[0]!.values[0]).toBe(conn.org_id);
    expect(sql.queries[0]!.values[3]).toBe("slack");
  });
});

describe("recordWebhookEvent", () => {
  it("is true on first sight and false on a duplicate", async () => {
    let seen = false;
    const sql = fakeSql([[/insert into ops\.webhook_events/, () => { if (seen) return []; seen = true; return [{ id: 1 }]; }]]);
    expect(await recordWebhookEvent("slack", "Ev1", {}, sql)).toBe(true);
    expect(await recordWebhookEvent("slack", "Ev1", {}, sql)).toBe(false);
  });
});

describe("paged run bookkeeping", () => {
  it("progressSyncRun stamps progress_at and only touches running rows", async () => {
    const { progressSyncRun } = await import("@/lib/connectors/store");
    const sql = fakeSql();
    await progressSyncRun("r1", { rows: 2000, pages: 1 }, sql);
    const q = sql.queries[0]!;
    expect(q.text).toMatch(/update context\.context_sync_runs set detail = \$1 where id = \$2 and status = 'running'/);
    const detail = (q.values[0] as { __json: Record<string, unknown> }).__json;
    expect(detail.rows).toBe(2000);
    expect(typeof detail.progress_at).toBe("string");
  });

  it("expireStaleSyncRuns judges staleness by the last progress, not the start", async () => {
    const { expireStaleSyncRuns } = await import("@/lib/connectors/store");
    const sql = fakeSql([[/update context\.context_sync_runs/, () => [{ id: "a" }, { id: "b" }]]]);
    expect(await expireStaleSyncRuns("c1", sql)).toBe(2);
    expect(sql.queries[0]!.text).toContain("coalesce((detail->>'progress_at')::timestamptz, started_at) < now()");
  });

  it("failRunningSyncRuns closes running rows and flags the connection", async () => {
    const { failRunningSyncRuns } = await import("@/lib/connectors/store");
    const sql = fakeSql([[/update context\.context_sync_runs set status = 'failed'/, () => [{ id: "a" }]]]);
    expect(await failRunningSyncRuns("c1", "The sync job failed after 3 attempts: boom", sql)).toBe(1);
    expect(sql.queries[1]!.text).toContain("update context.context_connections set last_error");
    const none = fakeSql();
    expect(await failRunningSyncRuns("c1", "x", none)).toBe(0);
    expect(none.queries.length).toBe(1);
  });

  it("upsertExternalMetrics writes in multi-row chunks", async () => {
    const { upsertExternalMetrics } = await import("@/lib/connectors/store");
    const sql = fakeSql([[/insert into measure\.external_metrics/, (q) => Array.from({ length: ((q.values[0] as { __rows: unknown[] }).__rows).length }, (_, i) => ({ id: String(i) }))]]);
    const rows = Array.from({ length: 1200 }, (_, i) => ({ provider: "profound" as const, surface: "profound_visibility", dimension: { engine: "chatgpt", prompt: `p${i}` }, date: "2026-09-01", metrics: { visibility: 1 } }));
    expect(await upsertExternalMetrics({ ...conn, site_id: "s1" }, rows, sql)).toBe(1200);
    expect(sql.queries.length).toBe(3);
    expect((sql.queries[0]!.values[0] as { __rows: unknown[] }).__rows.length).toBe(500);
    expect((sql.queries[2]!.values[0] as { __rows: unknown[] }).__rows.length).toBe(200);
  });
});
