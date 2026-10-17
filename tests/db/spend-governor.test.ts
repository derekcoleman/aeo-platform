import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { serpSpendSummary } from "@/lib/app/demand";
import { ANSWER_PROBE_TASK_KEY, BudgetExceededError, listBudgets, MAX_CAP_USD, postgresSpendGovernor, setBudgetCap, sweepSpendReservations, type BudgetAlert } from "@/lib/ops/spend";
import { assertArticleBudget, ArticleBudgetExceededError, runJsonTask } from "@/lib/pipeline/model";
import { createManualOpportunity, markOpportunity } from "@/lib/pipeline/opportunities";

/**
 * The spend governor against the real schema (0021): admission is one
 * conditional update per budget, so its guarantees — exactly one of two
 * racers gets the last dollar, a refusal on one budget undoes the hold on
 * another, each alert threshold is told once — only Postgres can check.
 * Runs only with AEO_TEST_DATABASE_URL; everything it creates is under
 * throwaway organisations, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("spend governor against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  // A second and third client: separate connections, so the racers really race.
  const racerA = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 1 });
  const racerB = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 1 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const STAFF = randomUUID();
  const ORGS = [ORG];
  const alerts: BudgetAlert[] = [];
  const gov = (db: postgres.Sql = sql) => postgresSpendGovernor(db, { env: { AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD: "10" }, onAlert: async (a) => void alerts.push(a) });

  /** A fresh organisation (and site) per test, so counters start where the test says. */
  async function freshOrg(serpBudget = 25): Promise<{ org: string; site: string }> {
    const org = randomUUID();
    const site = randomUUID();
    ORGS.push(org);
    await sql`insert into app.organizations (id, name, slug, serp_monthly_budget_usd) values (${org}, 'Spend test', ${`spend-${org.slice(0, 8)}`}, ${serpBudget})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${site}, ${org}, 'Spend test', ${`spend-${site.slice(0, 8)}.test`}, '/resources', ${`sp-${site.slice(0, 8)}.blogedge.test`}, 'active')`;
    return { org, site };
  }

  const counter = async (budgetId: string) => {
    const [c] = await sql<{ spent_usd: number; reserved_usd: number; alerted_pct: number }[]>`
      select spent_usd::float as spent_usd, reserved_usd::float as reserved_usd, alerted_pct from ops.spend_counters
      where budget_id = ${budgetId} order by period_start desc limit 1`;
    return c!;
  };
  const budgetId = async (org: string, resource: string, siteId: string | null = null) => {
    const [b] = await sql<{ id: string }[]>`select id from ops.budgets where org_id = ${org} and resource = ${resource}::ops.spend_resource and site_id is not distinct from ${siteId}::uuid and period = 'month'`;
    return b?.id ?? null;
  };

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Spend test', ${`spend-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Spend test', ${`spend-${SITE.slice(0, 8)}.test`}, '/resources', ${`sp-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = any (${ORGS}::uuid[])`;
    await Promise.all([sql.end(), racerA.end(), racerB.end()]);
  });

  it("lets exactly one of two racing reservations through when the cap has room for one", async () => {
    const { org } = await freshOrg();
    await sql`insert into ops.budgets (org_id, resource, cap_usd) values (${org}, 'llm', 1.00)`;
    const id = (await budgetId(org, "llm"))!;
    // Create this period's counter, then hold its row lock so both racers queue on it and are let go together.
    await gov().release(await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 0 }));
    let unlock!: () => void;
    const unlocked = new Promise<void>((r) => (unlock = r));
    const locker = sql.begin(async (tx) => {
      await tx`select 1 from ops.spend_counters where budget_id = ${id} for update`;
      await unlocked;
    });
    const racers = Promise.allSettled([
      gov(racerA).reserve({ orgId: org, resource: "llm", estimateUsd: 1.0, ref: { racer: "a" } }),
      gov(racerB).reserve({ orgId: org, resource: "llm", estimateUsd: 1.0, ref: { racer: "b" } }),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    unlock();
    await locker;
    const settled = await racers;
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(BudgetExceededError);
    expect(refused.reason).toMatchObject({ resource: "llm", orgId: org, limitUsd: 1 });
    expect(await counter(id)).toMatchObject({ spent_usd: 0, reserved_usd: 1 });
    expect(await sql`select 1 from ops.spend_reservations where org_id = ${org} and status = 'held'`).toHaveLength(1);
  });

  it("admits only while spent plus held is under the cap, however many race", async () => {
    const { org } = await freshOrg();
    await sql`insert into ops.budgets (org_id, resource, cap_usd) values (${org}, 'answer_probe', 1.00)`;
    const dbs = [sql, racerA, racerB];
    const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => gov(dbs[i % 3]).reserve({ orgId: org, resource: "answer_probe", estimateUsd: 0.4 })));
    // 0 → 0.4 → 0.8 are under 1.00; the fourth would start at 1.2.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await counter((await budgetId(org, "answer_probe"))!)).reserved_usd).toBeCloseTo(1.2, 5);
  });

  it("creates the org default from env (llm) or the org's own setting (serp), and starts a counter from the ledgers", async () => {
    const { org, site } = await freshOrg(40);
    await sql`insert into ops.llm_calls (org_id, site_id, task_key, model, cost_usd) values (${org}, ${site}, 'pipeline.draft', 'claude-opus-5-5', 3.25)`;
    await sql`insert into measure.serp_spend (org_id, site_id, provider, method, query, cost_usd, cached) values
      (${org}, ${site}, 'serpapi', 'serp', 'a', 0.02, false), (${org}, ${site}, 'serpapi', 'serp', 'a', 0, true)`;
    const llm = await gov().reserve({ orgId: org, siteId: site, resource: "llm", estimateUsd: 0.5 });
    const serp = await gov().reserve({ orgId: org, siteId: site, resource: "serp", estimateUsd: 0.02 });
    const budgets = await listBudgets({ orgId: org }, sql);
    expect(budgets.map((b) => [b.resource, b.site_id, b.period, b.cap_usd])).toEqual([["llm", null, "month", 10], ["serp", null, "month", 40]]);
    expect(budgets.find((b) => b.resource === "llm")).toMatchObject({ spent_usd: 3.25, reserved_usd: 0.5 });
    expect(budgets.find((b) => b.resource === "serp")).toMatchObject({ spent_usd: 0.02, reserved_usd: 0.02 });
    // The Demand page's headroom reads the same counter the governor admits by.
    expect(await serpSpendSummary(org, site, sql)).toMatchObject({ org_month_usd: 0.02, reserved_usd: 0.02, budget_usd: 40 });
    await gov().settle(llm, 0.2);
    await gov().settle(serp, 0.02);
    expect(await serpSpendSummary(org, site, sql)).toMatchObject({ org_month_usd: 0.04, reserved_usd: 0, budget_usd: 40 });

    // The org settings move the SERP cap; staff editing it here edit the setting.
    await sql`update app.organizations set serp_monthly_budget_usd = 60 where id = ${org}`;
    expect((await listBudgets({ orgId: org }, sql)).find((b) => b.resource === "serp")!.cap_usd).toBe(60);
    const serpBudget = (await budgetId(org, "serp"))!;
    await setBudgetCap(serpBudget, 75, STAFF, sql);
    expect((await sql<{ v: number }[]>`select serp_monthly_budget_usd::float as v from app.organizations where id = ${org}`)[0]!.v).toBe(75);
    expect((await listBudgets({ orgId: org }, sql)).find((b) => b.resource === "serp")!.cap_usd).toBe(75);
    await setBudgetCap((await budgetId(org, "llm"))!, 12.5, STAFF, sql);
    expect((await listBudgets({ orgId: org }, sql)).find((b) => b.resource === "llm")!.cap_usd).toBe(12.5);
    expect(await sql`select action from app.audit_log where actor_user_id = ${STAFF} and action = 'ops.budget_cap'`).toHaveLength(2);
    // The org SERP cap only goes as high as the org settings form accepts, or that form could never be saved again.
    expect(await setBudgetCap(serpBudget, 6000, STAFF, sql)).toMatchObject({ ok: false, error: expect.stringMatching(/up to 5000 USD/) });
    expect((await listBudgets({ orgId: org }, sql)).find((b) => b.resource === "serp")!.cap_usd).toBe(75);
    expect(await setBudgetCap((await budgetId(org, "llm"))!, 6000, STAFF, sql)).toMatchObject({ ok: true, before: 12.5 });
  });

  it("starts the model counter without answer-probe rows, and the probe counter from them", async () => {
    const { org, site } = await freshOrg();
    await sql`insert into ops.llm_calls (org_id, site_id, task_key, model, cost_usd) values
      (${org}, ${site}, 'pipeline.draft', 'claude-opus-5-5', 1.5), (${org}, ${site}, ${ANSWER_PROBE_TASK_KEY}, 'perplexity/sonar', 0.4)`;
    await gov().release(await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 0 }));
    await gov().release(await gov().reserve({ orgId: org, resource: "answer_probe", estimateUsd: 0 }));
    expect((await counter((await budgetId(org, "llm"))!)).spent_usd).toBe(1.5);
    expect((await counter((await budgetId(org, "answer_probe"))!)).spent_usd).toBe(0.4);
  });

  it("takes an env default above what a cap can hold as the most it holds, not an overflow on every call", async () => {
    const { org } = await freshOrg();
    const huge = postgresSpendGovernor(sql, { env: { AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD: "1000000000" } });
    await huge.release(await huge.reserve({ orgId: org, resource: "llm", estimateUsd: 0.1 }));
    expect(await listBudgets({ orgId: org }, sql)).toMatchObject([{ resource: "llm", cap_usd: MAX_CAP_USD }]);
  });

  it("checks every covering budget when the UTC period turns over between making counters and admitting", async () => {
    const { org, site } = await freshOrg();
    await sql`insert into ops.budgets (org_id, site_id, resource, period, cap_usd) values (${org}, ${site}, 'llm', 'day', 0)`;
    const [{ id: siteBudget }] = await sql<[{ id: string }]>`select id from ops.budgets where org_id = ${org} and site_id = ${site}`;
    // Midnight falls after the counters are made and before the admission
    // starts: inside it, the project budget has no counter for its period yet.
    const turnover = new Proxy(sql, {
      get(target, prop, receiver) {
        if (prop !== "begin") return Reflect.get(target, prop, receiver);
        return async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
          await sql`delete from ops.spend_counters where budget_id = ${siteBudget}`;
          return target.begin(fn);
        };
      },
    });
    const err = await gov(turnover).reserve({ orgId: org, siteId: site, resource: "llm", estimateUsd: 0.1 }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ siteId: site, period: "day", limitUsd: 0 });
    expect(await sql`select 1 from ops.spend_reservations where org_id = ${org}`).toHaveLength(0);
  });

  it("settles and releases exactly: held comes back, spent is the actual cost, twice is once", async () => {
    const { org } = await freshOrg();
    const res = await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 0.3 });
    const id = (await budgetId(org, "llm"))!;
    expect(await counter(id)).toMatchObject({ spent_usd: 0, reserved_usd: 0.3 });
    await gov().settle(res, 0.12);
    expect(await counter(id)).toMatchObject({ spent_usd: 0.12, reserved_usd: 0 });
    await gov().settle(res, 0.12);
    expect(await counter(id)).toMatchObject({ spent_usd: 0.12, reserved_usd: 0 });

    const failed = await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 0.5 });
    expect((await counter(id)).reserved_usd).toBeCloseTo(0.5, 5);
    await gov().release(failed);
    await gov().release(failed);
    expect(await counter(id)).toMatchObject({ spent_usd: 0.12, reserved_usd: 0 });
    const statuses = await sql<{ status: string; actual_usd: number | null }[]>`select status, actual_usd::float as actual_usd from ops.spend_reservations where org_id = ${org} order by created_at`;
    expect(statuses).toEqual([{ status: "settled", actual_usd: 0.12 }, { status: "released", actual_usd: null }]);
  });

  it("refused on a project budget, the hold on the org budget is undone too", async () => {
    const { org, site } = await freshOrg();
    await sql`insert into ops.budgets (org_id, site_id, resource, period, cap_usd) values (${org}, ${site}, 'serp', 'day', 0.05)`;
    const first = await gov().reserve({ orgId: org, siteId: site, resource: "serp", estimateUsd: 0.05 });
    await gov().settle(first, 0.05);
    const orgBudget = (await budgetId(org, "serp"))!;
    const before = await counter(orgBudget);
    const err = await gov().reserve({ orgId: org, siteId: site, resource: "serp", estimateUsd: 0.02 }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ siteId: site, period: "day", limitUsd: 0.05, spentUsd: 0.05 });
    expect(await counter(orgBudget)).toEqual(before);
    // The org's other projects are not held to this project's cap.
    const other = await gov().reserve({ orgId: org, siteId: null, resource: "serp", estimateUsd: 0.02 });
    expect(other.id).not.toBeNull();
    await gov().release(other);
  });

  it("tells each threshold once per period, however the settles interleave", async () => {
    const { org } = await freshOrg();
    alerts.length = 0;
    // $10 default from env; 7.9 spent so far.
    await gov().settle(await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 7.9 }), 7.9);
    expect(alerts).toEqual([]);
    const holds = await Promise.all([gov(racerA).reserve({ orgId: org, resource: "llm", estimateUsd: 0.2 }), gov(racerB).reserve({ orgId: org, resource: "llm", estimateUsd: 0.2 })]);
    await Promise.all([gov(racerA).settle(holds[0], 0.2), gov(racerB).settle(holds[1], 0.2)]);
    expect(alerts.map((a) => [a.orgId, a.resource, a.pct])).toEqual([[org, "llm", 80]]);
    await gov().settle(await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 0.1 }), 0.1);
    expect(alerts).toHaveLength(1);
    // Past the cap: the 100% alert, once, and then no more calls.
    await gov().settle(await gov().reserve({ orgId: org, resource: "llm", estimateUsd: 1.6 }), 1.65);
    expect(alerts.map((a) => a.pct)).toEqual([80, 100]);
    expect(alerts[1]).toMatchObject({ spentUsd: 10.05, capUsd: 10, period: "month" });
    await expect(gov().reserve({ orgId: org, resource: "llm", estimateUsd: 0.01 })).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await counter((await budgetId(org, "llm"))!)).alerted_pct).toBe(100);
  });

  it("sweeps holds a dead worker left, and a late settle still counts the spend", async () => {
    const { org } = await freshOrg();
    const res = await gov().reserve({ orgId: org, resource: "serp", estimateUsd: 0.4 });
    const stale = await gov().reserve({ orgId: org, resource: "serp", estimateUsd: 0.3 });
    const fresh = await gov().reserve({ orgId: org, resource: "serp", estimateUsd: 0.2 });
    await sql`update ops.spend_reservations set created_at = created_at - interval '45 minutes' where id in (${res.id}, ${stale.id})`;
    const swept = await sweepSpendReservations({}, sql);
    expect(swept.released).toBeGreaterThanOrEqual(2);
    const id = (await budgetId(org, "serp"))!;
    expect((await counter(id)).reserved_usd).toBeCloseTo(0.2, 5);
    await gov().settle(res, 0.35);
    expect(await counter(id)).toMatchObject({ spent_usd: 0.35 });
    expect((await counter(id)).reserved_usd).toBeCloseTo(0.2, 5);
    await gov().release(fresh);
    expect((await counter(id)).reserved_usd).toBe(0);
    // Closed holds past retention are dropped; the counter keeps the total.
    await sql`update ops.spend_reservations set closed_at = now() - interval '31 days' where org_id = ${org}`;
    expect((await sweepSpendReservations({}, sql)).purged).toBeGreaterThanOrEqual(3);
    expect(await sql`select 1 from ops.spend_reservations where org_id = ${org}`).toHaveLength(0);
    expect((await counter(id)).spent_usd).toBe(0.35);
  });

  it("runs a model task through the governor and ledgers run, opportunity and cache tokens; the article cap sums them", async () => {
    const [opp] = await sql<{ id: string }[]>`
      insert into content.opportunities (site_id, title, target_query, source, score, dedupe_key) values (${SITE}, 'spend test', 'spend test', 'manual', 50, ${`spend:${SITE}`}) returning id`;
    const m: TextModel = {
      id: "claude-opus-5-5",
      async complete() {
        return { text: '{"ok":true}', usage: { inputTokens: 2000, outputTokens: 900, model: "claude-opus-5-5", cacheReadTokens: 1200, cacheWriteTokens: 0 }, stopReason: "end_turn" };
      },
    };
    const governor = gov();
    const scope = { orgId: ORG, siteId: SITE, runId: "01JTESTRUN", opportunityId: opp!.id, governor };
    await runJsonTask("pipeline.brief", m, { system: "s", prompt: "p", promptVersion: "spend.v1" }, z.object({ ok: z.boolean() }), scope, sql);
    const [row] = await sql<{ run_id: string; opportunity_id: string; cache_read_input_tokens: number; stop_reason: string; cost_usd: number }[]>`
      select run_id, opportunity_id, cache_read_input_tokens, stop_reason, cost_usd::float as cost_usd from ops.llm_calls where opportunity_id = ${opp!.id}`;
    // Opus 5.5 at $4/$20: 2000 in, 900 out.
    expect(row).toEqual({ run_id: "01JTESTRUN", opportunity_id: opp!.id, cache_read_input_tokens: 1200, stop_reason: "end_turn", cost_usd: 0.026 });
    expect((await counter((await budgetId(ORG, "llm"))!)).spent_usd).toBeCloseTo(0.026, 5);

    await expect(assertArticleBudget(opp!.id, sql, {})).resolves.toEqual({ spentUsd: 0.026, capUsd: 15 });
    await expect(assertArticleBudget(opp!.id, sql, { AEO_ARTICLE_COST_CAP_USD: "0.02" })).rejects.toBeInstanceOf(ArticleBudgetExceededError);
  });

  it("starts an article's count over when a person asks for it again after it stopped, and only then", async () => {
    const title = "Spend reopen test";
    const { id } = await createManualOpportunity(SITE, { title }, sql);
    const spend = (usd: number) => sql`insert into ops.llm_calls (org_id, site_id, task_key, model, cost_usd, opportunity_id) values (${ORG}, ${SITE}, 'pipeline.draft', 'claude-opus-5-5', ${usd}, ${id})`;
    await spend(16);
    await expect(assertArticleBudget(id, sql, {})).rejects.toBeInstanceOf(ArticleBudgetExceededError);
    // Asked for again while still open: the same allowance.
    expect((await createManualOpportunity(SITE, { title }, sql)).id).toBe(id);
    await expect(assertArticleBudget(id, sql, {})).rejects.toBeInstanceOf(ArticleBudgetExceededError);
    // The run stopped at the cap and failed the opportunity; "Write about this" again reopens it with a fresh allowance.
    await markOpportunity(id, "failed", sql, "over its cap");
    expect((await createManualOpportunity(SITE, { title }, sql)).id).toBe(id);
    await expect(assertArticleBudget(id, sql, {})).resolves.toEqual({ spentUsd: 0, capUsd: 15 });
    await spend(2.5);
    await expect(assertArticleBudget(id, sql, {})).resolves.toEqual({ spentUsd: 2.5, capUsd: 15 });
  });
});
