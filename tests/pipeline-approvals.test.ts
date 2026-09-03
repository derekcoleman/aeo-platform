import { describe, expect, it } from "vitest";
import { approvalsSlackTarget, createApproval, expireApproval, loadApproval, recordDecision, requiredGates } from "@/lib/pipeline/approvals";
import { fakeSql } from "./helpers/fake-sql";
import { ORG_ID, SITE_ID } from "./fixtures/pipeline";

const when = new Date("2026-09-01T09:00:00.000Z");

describe("requiredGates", () => {
  it("maps each policy to the gates the pipeline must wait on", () => {
    expect(requiredGates("auto_publish")).toEqual([]);
    expect(requiredGates("approve_brief")).toEqual(["brief"]);
    expect(requiredGates("approve_post")).toEqual(["draft"]);
    expect(requiredGates("approve_both")).toEqual(["brief", "draft"]);
  });
});

describe("createApproval", () => {
  it("inserts one row per gate and returns its id", async () => {
    const sql = fakeSql([[/insert into content\.approvals/, () => [{ id: "ap-1" }]]]);
    const row = await createApproval({ siteId: SITE_ID, kind: "brief", briefId: "brief-1", expiresAt: when }, sql);
    expect(row).toEqual({ id: "ap-1" });
    expect(sql.queries[0]!.values).toEqual([SITE_ID, "brief", "brief-1", null, when]);
  });

  it("throws when the insert returns nothing", async () => {
    await expect(createApproval({ siteId: SITE_ID, kind: "draft" }, fakeSql())).rejects.toThrow(/no row/);
  });
});

describe("recordDecision", () => {
  it("applies the first decision on a pending row", async () => {
    const sql = fakeSql([[/update content\.approvals set status/, () => [{ id: "ap-1" }]]]);
    const out = await recordDecision("ap-1", { decision: "approve", by: { userId: "U1", name: "Dana" }, source: "slack" }, sql, when);
    expect(out).toEqual({ applied: true });
    const q = sql.queries[0]!;
    expect(q.text).toContain("where id = $6 and status = 'pending'");
    expect(q.values).toEqual(["approve", when, { __json: { userId: "U1", name: "Dana" } }, "slack", null, "ap-1"]);
  });

  it("reports applied:false for a second click on a decided row", async () => {
    const out = await recordDecision("ap-1", { decision: "changes", by: {}, source: "app", note: "tighten the intro" }, fakeSql(), when);
    expect(out).toEqual({ applied: false });
  });
});

describe("expireApproval", () => {
  it("only expires rows still pending", async () => {
    const sql = fakeSql([[/set status = 'expired'/, () => [{ id: "ap-1" }]]]);
    expect(await expireApproval("ap-1", sql, when)).toEqual({ applied: true });
    expect(sql.queries[0]!.values).toEqual([when, "ap-1"]);
    expect(await expireApproval("ap-1", fakeSql(), when)).toEqual({ applied: false });
  });
});

describe("loadApproval", () => {
  it("returns null for an unknown id", async () => {
    expect(await loadApproval("nope", fakeSql())).toBeNull();
  });
});

describe("approvalsSlackTarget", () => {
  const conn = (id: string, config: Record<string, unknown>) => ({
    id,
    org_id: ORG_ID,
    provider: "slack",
    config,
    scope: {},
    status: "active",
    enabled: true,
    secret_ref: null,
    external_account_id: "T1",
    external_account_name: "Acme",
    last_error: null,
  });

  it("is null when no active Slack connection opted into approvals", async () => {
    expect(await approvalsSlackTarget(ORG_ID, fakeSql())).toBeNull();
    const sql = fakeSql([[/from context\.context_connections/, () => [conn("c1", { ingestChannels: ["C1"] })]]]);
    expect(await approvalsSlackTarget(ORG_ID, sql)).toBeNull();
  });

  it("returns the first connection carrying an approvals channel, scoped to the org", async () => {
    const sql = fakeSql([[/from context\.context_connections/, () => [conn("c1", {}), conn("c2", { approvalsChannel: "C-APPROVALS" })]]]);
    const target = await approvalsSlackTarget(ORG_ID, sql);
    expect(target?.channel).toBe("C-APPROVALS");
    expect(target?.conn.id).toBe("c2");
    const outer = sql.queries.find((q) => q.text.includes("from context.context_connections"))!;
    expect(outer.text).toContain("select * from context.context_connections");
    const fragments = sql.queries.filter((q) => !q.text.includes("from context.context_connections")).map((q) => q.text);
    expect(fragments).toContain("and org_id = $1");
    expect(fragments).toContain("and provider = $1");
    expect(fragments).toContain("and enabled and status in ('active', 'error')");
  });
});
