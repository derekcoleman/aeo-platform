import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Completion, TextModel } from "@/lib/ai/model";
import { ModelRefusalError } from "@/lib/ai/model";
import {
  ANSWER_PROBE_TASK_KEY,
  BudgetExceededError,
  budgetAlertText,
  budgetCapMaxUsd,
  crossedThreshold,
  defaultMonthlyCapUsd,
  defaultSpendGovernor,
  MAX_CAP_USD,
  noopGovernor,
  periodEnd,
  postgresSpendGovernor,
  retryOnConflict,
  roundUsd,
  usdFromEnv,
  type BudgetAlert,
  type Reservation,
  type SpendGovernor,
  type SpendRequest,
} from "@/lib/ops/spend";
import { ArticleBudgetExceededError, assertArticleBudget, articleCostCapUsd, runJsonTask, worstCaseCostUsd } from "@/lib/pipeline/model";
import { BudgetExceededError as SerpBudgetExceededError, createSerpClient, postgresBudget, type SerpProvider, type SerpQuery, type SerpResult } from "@/lib/serp";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";

/** An in-memory governor that records what it was asked, for the callers' tests. */
function recordingGovernor(opts: { refuse?: boolean } = {}): SpendGovernor & { calls: string[]; requests: SpendRequest[]; settled: number[] } {
  const calls: string[] = [];
  const requests: SpendRequest[] = [];
  const settled: number[] = [];
  let n = 0;
  return {
    enabled: true,
    calls,
    requests,
    settled,
    async reserve(req) {
      calls.push("reserve");
      requests.push(req);
      if (opts.refuse) throw new BudgetExceededError(req.resource, req.orgId, 200, 200);
      return { id: `r${++n}`, orgId: req.orgId, siteId: req.siteId ?? null, resource: req.resource, estimateUsd: req.estimateUsd };
    },
    async settle(res: Reservation, actual: number) {
      calls.push(`settle:${res.id}`);
      settled.push(actual);
    },
    async release(res: Reservation) {
      calls.push(`release:${res.id}`);
    },
  };
}

function model(reply: Partial<Completion> | Error): TextModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "anthropic/claude-sonnet-5.5",
    prompts,
    async complete(prompt) {
      prompts.push(prompt);
      if (reply instanceof Error) throw reply;
      return { text: '{"ok":true}', usage: { inputTokens: 1000, outputTokens: 200, model: "anthropic/claude-sonnet-5.5", costUsd: 0.0042, cacheReadTokens: 300, cacheWriteTokens: 50 }, stopReason: "end_turn", ...reply };
    },
  };
}

const schema = z.object({ ok: z.boolean() });
const input = { system: "s".repeat(350), prompt: "p".repeat(3150), promptVersion: "test.v1" };

describe("runJsonTask under the governor", () => {
  it("holds the worst case before the call, settles the actual cost, and ledgers the new columns with content_item_id last", async () => {
    const sql = fakeSql();
    const governor = recordingGovernor();
    const { run } = await runJsonTask("pipeline.brief", model({}), input, schema, { orgId: ORG, siteId: SITE, contentItemId: "item-1", runId: "run-1", opportunityId: "opp-1", governor }, sql);
    expect(governor.calls).toEqual(["reserve", "settle:r1"]);
    // 3500 chars ≈ 1000 tokens in, every one of the 16k output tokens out, at Sonnet 5.5's $2/$10.
    expect(governor.requests[0]).toMatchObject({ orgId: ORG, siteId: SITE, resource: "llm", estimateUsd: worstCaseCostUsd("anthropic/claude-sonnet-5.5", input, 16_000) });
    expect(governor.requests[0]!.estimateUsd).toBeCloseTo(0.162, 5);
    expect(governor.requests[0]!.ref).toMatchObject({ task: "pipeline.brief", runId: "run-1", opportunityId: "opp-1", maxTokens: 16_000 });
    expect(governor.settled).toEqual([0.0042]);
    expect(run).toMatchObject({ cacheReadTokens: 300, cacheWriteTokens: 50, stopReason: "end_turn" });

    const ins = sql.queries[0]!;
    expect(ins.text).toContain("cache_creation_input_tokens, cache_read_input_tokens, stop_reason, run_id, opportunity_id, content_item_id)");
    expect(ins.values.slice(0, 3)).toEqual([ORG, SITE, "pipeline.brief"]);
    expect(ins.values.slice(-6)).toEqual([50, 300, "end_turn", "run-1", "opp-1", "item-1"]);
  });

  it("gives the hold back when the call throws, and pays nothing", async () => {
    const sql = fakeSql();
    const governor = recordingGovernor();
    await expect(runJsonTask("pipeline.draft", model(new Error("openrouter 503")), input, schema, { orgId: ORG, governor }, sql)).rejects.toThrow("openrouter 503");
    expect(governor.calls).toEqual(["reserve", "release:r1"]);
    expect(sql.queries).toHaveLength(0);
  });

  it("refuses before the model is called when the budget is spent", async () => {
    const sql = fakeSql();
    const m = model({});
    await expect(runJsonTask("pipeline.draft", m, input, schema, { orgId: ORG, governor: recordingGovernor({ refuse: true }) }, sql)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(m.prompts).toHaveLength(0);
    expect(sql.queries).toHaveLength(0);
  });

  it("settles a refusal (it was paid for) before handing it to a human", async () => {
    const governor = recordingGovernor();
    await expect(runJsonTask("pipeline.brief", model({ stopReason: "refusal" }), input, schema, { orgId: ORG, governor }, fakeSql())).rejects.toBeInstanceOf(ModelRefusalError);
    expect(governor.calls).toEqual(["reserve", "settle:r1"]);
  });

  it("ledgers a paid call even when counting it fails", async () => {
    const sql = fakeSql();
    const governor = { ...recordingGovernor(), settle: async () => { throw new Error("connection reset"); } };
    await expect(runJsonTask("pipeline.brief", model({}), input, schema, { orgId: ORG, governor }, sql)).rejects.toThrow("connection reset");
    expect(sql.queries.map((q) => q.text.split(" (")[0])).toEqual(["insert into ops.llm_calls"]);
  });

  it("holds each attempt separately when a cut-off is retried with more room", async () => {
    let n = 0;
    const m: TextModel = {
      id: "claude-haiku-5-5",
      async complete() {
        n++;
        return { text: n === 1 ? '{"ok":' : '{"ok":true}', usage: { inputTokens: 10, outputTokens: 5, model: "claude-haiku-5-5" }, stopReason: n === 1 ? "max_tokens" : "end_turn" };
      },
    };
    const governor = recordingGovernor();
    await runJsonTask("context.facts.extract", m, input, schema, { orgId: ORG, governor }, fakeSql());
    expect(governor.calls).toEqual(["reserve", "settle:r1", "reserve", "settle:r2"]);
    expect(governor.requests[1]!.estimateUsd).toBeGreaterThan(governor.requests[0]!.estimateUsd);
  });

  it("uses the no-op governor without a database, so fake-SQL callers see only their own queries", async () => {
    expect(defaultSpendGovernor(fakeSql(), {}).enabled).toBe(false);
    expect(defaultSpendGovernor(fakeSql(), { DATABASE_URL: "postgres://x", AEO_SPEND_GOVERNOR: "off" }).enabled).toBe(false);
    expect(defaultSpendGovernor(fakeSql(), { DATABASE_URL: "postgres://x" }).enabled).toBe(true);
    // runJsonTask's default reads process.env: pinned here, so a URL the shell exports cannot switch it.
    for (const name of ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"]) vi.stubEnv(name, "");
    try {
      const sql = fakeSql();
      await runJsonTask("pipeline.brief", model({}), input, schema, { orgId: ORG }, sql);
      expect(sql.queries).toHaveLength(1);
      expect(sql.queries[0]!.text).toMatch(/^insert into ops\.llm_calls/);
    } finally {
      vi.unstubAllEnvs();
    }
    const res = await noopGovernor().reserve({ orgId: ORG, resource: "serp", estimateUsd: 1 });
    expect(res.id).toBeNull();
  });
});

describe("the per-article cap", () => {
  it("sums the article's model spend and refuses at or over the cap", async () => {
    const at = (spent: number) => fakeSql([[/from ops\.llm_calls l left join content\.opportunities o/, () => [{ spent_usd: spent }]]]);
    await expect(assertArticleBudget("opp-1", at(14.99), {})).resolves.toEqual({ spentUsd: 14.99, capUsd: 15 });
    await expect(assertArticleBudget("opp-1", at(15), {})).rejects.toBeInstanceOf(ArticleBudgetExceededError);
    await expect(assertArticleBudget("opp-1", at(4), { AEO_ARTICLE_COST_CAP_USD: "3" })).rejects.toThrow(/\$4\.00 .* \$3\.00 cap/);
    const sql = at(0);
    await assertArticleBudget("opp-9", sql, {});
    expect(sql.queries[0]!.values).toEqual(["opp-9"]);
    // Counted from the last time a person reopened the article, so asking for it again is the way past the cap.
    expect(sql.queries[0]!.text).toContain("and l.created_at >= coalesce(o.cost_cap_reset_at, '-infinity')");
    await expect(assertArticleBudget("opp-1", at(15), {})).rejects.toThrow(/asking for it again \("Write about this"/);
  });

  it("reads the cap from env, ignoring a blank or malformed value", () => {
    expect(articleCostCapUsd({})).toBe(15);
    expect(articleCostCapUsd({ AEO_ARTICLE_COST_CAP_USD: "" })).toBe(15);
    expect(articleCostCapUsd({ AEO_ARTICLE_COST_CAP_USD: "abc" })).toBe(15);
    expect(articleCostCapUsd({ AEO_ARTICLE_COST_CAP_USD: "-1" })).toBe(15);
    expect(articleCostCapUsd({ AEO_ARTICLE_COST_CAP_USD: "40" })).toBe(40);
    expect(usdFromEnv("X", 7, { X: " 0 " })).toBe(0);
  });
});

describe("postgresSpendGovernor (SQL shape)", () => {
  const budgetRows = [{ budget_id: "b-org", site_id: null, period: "month", cap_usd: 200, spent_usd: 150 }, { budget_id: "b-site", site_id: SITE, period: "day", cap_usd: 5, spent_usd: 5.2 }];

  it("ensures the org default and this period's counters, then admits with one conditional update and records the hold", async () => {
    const sql = fakeSql([
      [/from ops\.budgets b join ops\.spend_counters c/, () => budgetRows],
      [/^update ops\.spend_counters c set reserved_usd = c\.reserved_usd \+/, () => [{ budget_id: "b-org" }, { budget_id: "b-site" }]],
      [/^insert into ops\.spend_reservations/, () => [{ id: "res-1" }]],
    ]);
    const res = await postgresSpendGovernor(sql, { env: {} }).reserve({ orgId: ORG, siteId: SITE, resource: "llm", estimateUsd: 0.1234567, ref: { task: "pipeline.draft" } });
    expect(res).toEqual({ id: "res-1", orgId: ORG, siteId: SITE, resource: "llm", estimateUsd: 0.12346 });

    const [defaults, counters, txCounters, select, admit, hold] = sql.queries;
    expect(defaults!.text).toMatch(/^insert into ops\.budgets \(org_id, resource, period, cap_usd\)/);
    expect(defaults!.text).toContain("then o.serp_monthly_budget_usd else $3::numeric end");
    expect(defaults!.values.slice(0, 3)).toEqual(["llm", "llm", 200]);
    expect(defaults!.text).toContain("on conflict do nothing");
    expect(counters!.text).toMatch(/^insert into ops\.spend_counters \(budget_id, org_id, period_start, spent_usd\)/);
    expect(counters!.text).toContain("from ops.llm_calls l");
    expect(counters!.text).toContain("from measure.serp_spend s");
    // Probes are ledgered in ops.llm_calls too: the model counter leaves their rows out, the probe counter starts from them.
    expect(counters!.text).toContain("when 'llm' then (select coalesce(sum(l.cost_usd), 0) from ops.llm_calls l where l.org_id = b.org_id and (b.site_id is null or l.site_id = b.site_id) and l.task_key <> $1");
    expect(counters!.text).toContain("and l.task_key = $2");
    expect(counters!.values.slice(0, 2)).toEqual([ANSWER_PROBE_TASK_KEY, ANSWER_PROBE_TASK_KEY]);
    // Made again inside the admission, under its now(), right before the budgets are read: a period that turned
    // over between the two cannot drop a budget out of the check.
    expect(txCounters).toEqual(counters);
    expect(select!.text).toMatch(/^select b\.id as budget_id/);
    expect(select!.values).toEqual([ORG, "llm", SITE]);
    expect(admit!.text).toContain("and c.spent_usd + c.reserved_usd < b.cap_usd returning c.budget_id");
    expect(admit!.values).toEqual([0.12346, ["b-org", "b-site"]]);
    expect(hold!.values.slice(0, 5)).toEqual([ORG, SITE, "llm", ["b-org", "b-site"], 0.12346]);
    expect(hold!.values[5]).toEqual({ __json: { task: "pipeline.draft" } });
  });

  it("refuses with the budget that has no room and records no hold", async () => {
    const sql = fakeSql([
      [/from ops\.budgets b join ops\.spend_counters c/, () => budgetRows],
      [/^update ops\.spend_counters c set reserved_usd = c\.reserved_usd \+/, () => [{ budget_id: "b-org" }]],
    ]);
    const err = await postgresSpendGovernor(sql, { env: {} }).reserve({ orgId: ORG, siteId: SITE, resource: "serp", estimateUsd: 0.02 }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ resource: "serp", orgId: ORG, siteId: SITE, spentUsd: 5.2, limitUsd: 5, period: "day" });
    expect(err.message).toBe(`serp budget exceeded for site ${SITE}: spent 5.20 of 5.00 USD today`);
    expect(sql.queries.some((q) => q.text.startsWith("insert into ops.spend_reservations"))).toBe(false);
    // The SERP client's error is the same class, so its instanceof checks still hold.
    expect(err).toBeInstanceOf(SerpBudgetExceededError);
  });

  it("fails loudly for an organisation with no budget at all", async () => {
    await expect(postgresSpendGovernor(fakeSql(), { env: {} }).reserve({ orgId: ORG, resource: "llm", estimateUsd: 1 })).rejects.toThrow(/no llm budget for org/);
  });

  it("settles the hold, counts the spend, and tells a crossed threshold once, after commit", async () => {
    const alerts: BudgetAlert[] = [];
    const counter = { budget_id: "b-org", period_start: "2026-10-01", spent_usd: 165, alerted_pct: 0, cap_usd: 200, alert_pcts: [80, 100], org_id: ORG, site_id: null, site_domain: null, resource: "llm", period: "month" };
    const sql = fakeSql([
      [/^select status, amount_usd::text as amount_usd from ops\.spend_reservations/, () => [{ status: "held", amount_usd: "0.40000" }]],
      [/^update ops\.spend_counters c set reserved_usd = greatest/, () => [counter]],
      [/^update ops\.spend_counters set alerted_pct/, () => [{ budget_id: "b-org" }]],
    ]);
    const gov = postgresSpendGovernor(sql, { env: {}, onAlert: async (a) => void alerts.push(a) });
    await gov.settle({ id: "res-1", orgId: ORG, siteId: null, resource: "llm", estimateUsd: 0.4 }, 0.31);
    const texts = sql.queries.map((q) => q.text);
    expect(texts[0]).toContain("for update");
    expect(texts[1]).toMatch(/^update ops\.spend_reservations set status = 'settled', actual_usd = \$1/);
    expect(sql.queries[2]!.values.slice(0, 2)).toEqual(["0.40000", 0.31]);
    expect(sql.queries[3]!.text).toContain("and alerted_pct < $4");
    expect(sql.queries[3]!.values).toEqual([80, "b-org", "2026-10-01", 80]);
    expect(alerts).toEqual([{ orgId: ORG, siteId: null, siteDomain: null, resource: "llm", period: "month", periodStart: "2026-10-01", pct: 80, spentUsd: 165, capUsd: 200 }]);
  });

  it("tells no one when another settle already claimed the threshold, and counts only the spend of a swept hold", async () => {
    const alerts: BudgetAlert[] = [];
    const sql = fakeSql([
      [/^select status, amount_usd::text as amount_usd from ops\.spend_reservations/, () => [{ status: "released", amount_usd: "0.40000" }]],
      [/^update ops\.spend_counters c set reserved_usd = greatest/, () => [{ budget_id: "b-org", period_start: "2026-10-01", spent_usd: 170, alerted_pct: 0, cap_usd: 200, alert_pcts: [80, 100], org_id: ORG, site_id: null, site_domain: null, resource: "llm", period: "month" }]],
    ]);
    await postgresSpendGovernor(sql, { env: {}, onAlert: async (a) => void alerts.push(a) }).settle({ id: "res-1", orgId: ORG, siteId: null, resource: "llm", estimateUsd: 0.4 }, 0.31);
    expect(sql.queries[2]!.values.slice(0, 2)).toEqual(["0", 0.31]);
    expect(alerts).toEqual([]);
  });

  it("runs a settle again when Postgres aborted it over a lock conflict, and nothing else", async () => {
    const sql = fakeSql([
      [/^select status, amount_usd::text as amount_usd from ops\.spend_reservations/, () => [{ status: "held", amount_usd: "0.40000" }]],
    ]);
    const begin = sql.begin.bind(sql);
    let aborted = 0;
    Object.assign(sql, {
      begin: async (fn: (tx: typeof sql) => Promise<unknown>) => {
        if (aborted++ === 0) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return begin(fn as never);
      },
    });
    await postgresSpendGovernor(sql, { env: {} }).settle({ id: "res-1", orgId: ORG, siteId: null, resource: "llm", estimateUsd: 0.4 }, 0.31);
    expect(aborted).toBe(2);
    expect(sql.queries.some((q) => q.text.startsWith("update ops.spend_reservations set status = 'settled'"))).toBe(true);

    let calls = 0;
    await expect(retryOnConflict(async () => { calls++; throw Object.assign(new Error("unique violation"), { code: "23505" }); })).rejects.toThrow("unique violation");
    expect(calls).toBe(1);
    calls = 0;
    await expect(retryOnConflict(async () => { calls++; throw Object.assign(new Error("could not serialize"), { code: "40001" }); })).rejects.toThrow("could not serialize");
    expect(calls).toBe(3);
  });

  it("holds an env default to what a cap can store, so a huge value is not an overflow on every call", async () => {
    expect(defaultMonthlyCapUsd("llm", { AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD: "1000000000" })).toBe(MAX_CAP_USD);
    expect(defaultMonthlyCapUsd("answer_probe", { AEO_DEFAULT_ANSWER_PROBE_MONTHLY_BUDGET_USD: "1e12" })).toBe(MAX_CAP_USD);
    expect(defaultMonthlyCapUsd("llm", { AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD: "350" })).toBe(350);
    expect(defaultMonthlyCapUsd("serp", {})).toBeNull();
    const sql = fakeSql();
    await postgresSpendGovernor(sql, { env: { AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD: "1000000000" } }).reserve({ orgId: ORG, resource: "llm", estimateUsd: 0.1 }).catch(() => null);
    expect(sql.queries[0]!.values[2]).toBe(MAX_CAP_USD);
  });

  it("limits the org-wide SERP cap in Ops to what the org settings form accepts", () => {
    expect(budgetCapMaxUsd({ resource: "serp", site_id: null, period: "month" })).toBe(5000);
    expect(budgetCapMaxUsd({ resource: "serp", site_id: SITE, period: "month" })).toBe(100_000);
    expect(budgetCapMaxUsd({ resource: "serp", site_id: null, period: "day" })).toBe(100_000);
    expect(budgetCapMaxUsd({ resource: "llm", site_id: null, period: "month" })).toBe(100_000);
  });

  it("settles once: a second settle of the same hold changes nothing", async () => {
    const sql = fakeSql([[/^select status/, () => [{ status: "settled", amount_usd: "0.40000" }]]]);
    await postgresSpendGovernor(sql, { env: {} }).settle({ id: "res-1", orgId: ORG, siteId: null, resource: "llm", estimateUsd: 0.4 }, 0.31);
    expect(sql.queries).toHaveLength(1);
  });

  it("releases only a held reservation, in one statement", async () => {
    const sql = fakeSql();
    const gov = postgresSpendGovernor(sql, { env: {} });
    await gov.release({ id: "res-1", orgId: ORG, siteId: null, resource: "serp", estimateUsd: 0.02 });
    await gov.release({ id: null, orgId: ORG, siteId: null, resource: "serp", estimateUsd: 0.02 });
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]!.text).toContain("where id = $1 and status = 'held'");
    expect(sql.queries[0]!.text).toContain("set reserved_usd = greatest(0, c.reserved_usd - r.amount_usd)");
  });
});

describe("alerts", () => {
  it("picks the highest new threshold reached, never one already told", () => {
    expect(crossedThreshold(150, 200, [80, 100], 0)).toBeNull();
    expect(crossedThreshold(160, 200, [80, 100], 0)).toBe(80);
    expect(crossedThreshold(170, 200, [80, 100], 80)).toBeNull();
    expect(crossedThreshold(205, 200, [80, 100], 0)).toBe(100);
    expect(crossedThreshold(205, 200, [80, 100], 80)).toBe(100);
    expect(crossedThreshold(205, 200, [80, 100], 100)).toBeNull();
    expect(crossedThreshold(1, 0, [80, 100], 0)).toBeNull();
  });

  it("says what was reached and when it starts over", () => {
    const base: BudgetAlert = { orgId: ORG, siteId: null, siteDomain: null, resource: "llm", period: "month", periodStart: "2026-12-01", pct: 80, spentUsd: 161.2, capUsd: 200 };
    expect(budgetAlertText(base)).toEqual({ subject: "Model budget at 80%", text: "Model budget at 80%: $161.20 of the $200.00 monthly cap used. Calls stop at 100% until 2027-01-01 (UTC) or until the cap is raised." });
    expect(budgetAlertText({ ...base, resource: "serp", siteId: SITE, siteDomain: "acme.com", period: "day", periodStart: "2026-10-31", pct: 100, spentUsd: 5.01, capUsd: 5 }).text).toBe(
      "SERP budget for acme.com reached: $5.01 of the $5.00 daily cap. New SERP calls are refused until 2026-11-01 (UTC) or until the cap is raised.",
    );
    expect(periodEnd("2026-01-31", "day").toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(periodEnd("2026-01-01", "month").toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rounds to the ledger's precision and never holds a negative amount", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(-1)).toBe(0);
    expect(roundUsd(Number.NaN)).toBe(0);
  });
});

describe("SERP spend through the governor", () => {
  const q: SerpQuery = { query: "sso vs scim", locale: { country: "US", language: "EN" }, device: "desktop" };
  const result = (cost: number): SerpResult => ({ provider: "dataforseo", query: q.query, locale: q.locale, device: q.device, fetchedAt: "2026-10-01T00:00:00Z", organic: [], paa: [], featuredSnippet: null, aiOverview: null, raw: null, costUsd: cost });
  const provider = (serp: () => Promise<SerpResult>): SerpProvider => ({
    name: "dataforseo",
    serp,
    async autocomplete() { throw new Error("unused"); },
    async paa() { return []; },
    async aiOverview() { return null; },
  });

  it("holds the estimate as resource serp, settles the reported cost before the ledger row", async () => {
    const sql = fakeSql();
    const governor = recordingGovernor();
    const client = createSerpClient({ bulk: provider(async () => result(0.0015)), budget: postgresBudget(sql, governor), estimate: { dataforseo: { serp: 0.002, autocomplete: 0.0006 } } });
    await client.serp(q, { orgId: ORG, siteId: SITE });
    expect(governor.requests[0]).toEqual({ orgId: ORG, siteId: SITE, resource: "serp", estimateUsd: 0.002, ref: { provider: "dataforseo", method: "serp", query: "sso vs scim" } });
    expect(governor.calls).toEqual(["reserve", "settle:r1"]);
    expect(governor.settled).toEqual([0.0015]);
    expect(sql.queries.map((x) => x.text.split(" (")[0])).toEqual(["insert into measure.serp_spend"]);
  });

  it("settles as soon as the vendor answers; a failed cache write does not fail a paid call", async () => {
    const order: string[] = [];
    const governor = recordingGovernor();
    const sql = fakeSql([[/^insert into measure\.serp_spend/, () => void order.push("ledger")]]);
    const cache = {
      async get() { return null; },
      async set() { order.push("cache"); throw new Error("serp_cache: connection reset"); },
    };
    const client = createSerpClient({ bulk: provider(async () => result(0.0015)), cache, budget: postgresBudget(sql, { ...governor, settle: async (res, actual) => { order.push("settle"); await governor.settle(res, actual); } }) });
    await expect(client.serp(q, { orgId: ORG })).resolves.toMatchObject({ cached: false, costUsd: 0.0015 });
    expect(order).toEqual(["settle", "ledger", "cache"]);
    expect(governor.settled).toEqual([0.0015]);
  });

  it("ledgers a paid SERP call even when settling it fails", async () => {
    const sql = fakeSql();
    const guard = postgresBudget(sql, { ...recordingGovernor(), settle: async () => { throw new Error("connection reset"); } });
    const hold = await guard.reserve(ORG, 0.02, { siteId: null, provider: "serpapi", method: "serp", query: "x" });
    await expect(guard.record({ orgId: ORG, siteId: null, provider: "serpapi", method: "serp", query: "x", costUsd: 0.02, cached: false }, hold)).rejects.toThrow("connection reset");
    expect(sql.queries.map((x) => x.text.split(" (")[0])).toEqual(["insert into measure.serp_spend"]);
  });

  it("gives the hold back when the vendor call throws", async () => {
    const governor = recordingGovernor();
    const client = createSerpClient({ bulk: provider(async () => { throw new Error("dataforseo 500"); }), budget: postgresBudget(fakeSql(), governor) });
    await expect(client.serp(q, { orgId: ORG })).rejects.toThrow("dataforseo 500");
    expect(governor.calls).toEqual(["reserve", "release:r1"]);
  });

  it("falls back to the month-to-date check when the governor is off", async () => {
    const sql = fakeSql([[/from app\.organizations o where o\.id/, () => [{ limit_usd: "25.00", spent_usd: "24.99" }]]]);
    const guard = postgresBudget(sql, noopGovernor());
    await expect(guard.reserve(ORG, 0.02, { siteId: null, provider: "serpapi", method: "serp", query: "x" })).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(guard.reserve(ORG, 0.005, { siteId: null, provider: "serpapi", method: "serp", query: "x" })).resolves.toBeNull();
  });
});
