import { describe, expect, it } from "vitest";
import { healthAlertText } from "@/lib/proxy/alerts";
import type { HealthResult } from "@/lib/proxy/health";
import { completePreflight, createPreflight, HEALTH_ALERT_AFTER, markSiteVerified, recordHealthCheck } from "@/lib/proxy/store";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-03T12:00:00Z");
const failing: HealthResult = { ok: false, ttfbMs: 900, failed: ["health_endpoint"], warnings: [], checks: [{ key: "health_endpoint", ok: false, severity: "fail", detail: { status: 404, hint: "the rewrite is gone" } }] };
const healthy: HealthResult = { ok: true, ttfbMs: 120, failed: [], warnings: [], checks: [] };

function sqlWith(prev: { health_failures: number; last_health_ok: boolean | null; health_alerted_at: Date | null }) {
  return fakeSql([[/for update/, () => [prev]]]);
}

describe("recordHealthCheck", () => {
  it("counts consecutive failures and alerts exactly once, at the threshold", async () => {
    const first = await recordHealthCheck({ id: SITE, org_id: ORG }, "monitor", failing, sqlWith({ health_failures: 0, last_health_ok: true, health_alerted_at: null }), NOW);
    expect(first).toEqual({ failures: 1, previousOk: true, alertFailure: false, alertRecovery: false });
    const sql = sqlWith({ health_failures: 1, last_health_ok: false, health_alerted_at: null });
    const second = await recordHealthCheck({ id: SITE, org_id: ORG }, "monitor", failing, sql, NOW);
    expect(second).toEqual({ failures: HEALTH_ALERT_AFTER, previousOk: false, alertFailure: true, alertRecovery: false });
    const ins = sql.queries.find((q) => q.text.startsWith("insert into app.site_health_checks"))!;
    expect(ins.values.slice(0, 6)).toEqual([ORG, SITE, "monitor", NOW, false, 900]);
    expect(ins.values[6]).toEqual({ __array: ["health_endpoint"] });
    const upd = sql.queries.find((q) => q.text.startsWith("update app.sites"))!;
    expect(upd.values.slice(0, 4)).toEqual([2, NOW, false, NOW]);
    const third = await recordHealthCheck({ id: SITE, org_id: ORG }, "monitor", failing, sqlWith({ health_failures: 2, last_health_ok: false, health_alerted_at: NOW }), NOW);
    expect(third).toMatchObject({ failures: 3, alertFailure: false, alertRecovery: false });
  });

  it("resets on success and alerts recovery only when a failure alert went out", async () => {
    const sql = sqlWith({ health_failures: 3, last_health_ok: false, health_alerted_at: NOW });
    expect(await recordHealthCheck({ id: SITE, org_id: ORG }, "monitor", healthy, sql, NOW)).toEqual({ failures: 0, previousOk: false, alertFailure: false, alertRecovery: true });
    expect(sql.queries.find((q) => q.text.startsWith("update app.sites"))!.values[3]).toBeNull();
    expect(await recordHealthCheck({ id: SITE, org_id: ORG }, "monitor", healthy, sqlWith({ health_failures: 1, last_health_ok: false, health_alerted_at: null }), NOW)).toMatchObject({ alertRecovery: false });
  });
});

describe("verification + preflights", () => {
  it("markSiteVerified only flips provisioning/verifying sites and keeps the first verified_at", async () => {
    const sql = fakeSql();
    await markSiteVerified(SITE, ORG, sql, NOW);
    expect(sql.queries[0]!.text).toContain("status in ('provisioning', 'verifying')");
    expect(sql.queries[0]!.text).toContain("coalesce(verified_at, $1)");
  });

  it("createPreflight / completePreflight persist the result and the crawler report separately", async () => {
    const sql = fakeSql([[/insert into app\.site_preflights/, () => [{ id: "p1" }]]]);
    expect(await createPreflight(SITE, "crawler_report", sql)).toEqual({ id: "p1" });
    expect(sql.queries[0]!.values).toEqual([SITE, "crawler_report"]);
    await completePreflight("p1", { ok: true, result: { blocking: [] }, crawlerAccess: null }, sql, NOW);
    const q = sql.queries[1]!;
    expect(q.values[0]).toBe(true);
    expect(q.values[1]).toEqual({ __json: { blocking: [] } });
    expect(q.values[2]).toBeNull();
  });
});

describe("healthAlertText", () => {
  it("names the prefix, the streak and each failing check with its hint; recovery is one line", () => {
    const text = healthAlertText({ site: { id: SITE, name: "Acme", canonicalDomain: "acme.com", pathPrefix: "/resources" }, ok: false, failures: 2, result: failing, appUrl: "https://app.aeo.app" });
    expect(text).toContain("Proxy health failing for acme.com/resources (2 checks in a row).");
    expect(text).toContain("• health_endpoint — http 404; the rewrite is gone");
    expect(text).toContain("Only the content prefix is affected");
    expect(text).toContain(`https://app.aeo.app/sites/${SITE}/health`);
    expect(healthAlertText({ site: { id: SITE, name: "Acme", canonicalDomain: "acme.com", pathPrefix: "/resources" }, ok: true, failures: 0, result: healthy })).toBe("Recovered: acme.com/resources is serving again.");
  });
});
