import { describe, expect, it } from "vitest";
import { answerEngines, type AnswerEngineConfig } from "@/lib/answers/engines";
import { AnswerProbeError, type ProbeResult } from "@/lib/answers/openrouter-probe";
import { answerHash } from "@/lib/answers/record";
import { ANSWER_PROBES_FEATURE, fitPanel, loadAnswerPanel, MAX_PROBE_STEPS, probeFailure, sampleAnswer, sitesForAnswerProbes, type SampleDeps } from "@/lib/answers/sample";
import { engineVisibility, summarizeEngines } from "@/lib/app/visibility";
import type { SiteOwnership } from "@/lib/demand/store";
import { ANSWER_PROBE_TASK_KEY, BudgetExceededError, type Reservation, type SpendGovernor, type SpendRequest } from "@/lib/ops/spend";
import { memoryCache } from "@/lib/serp/cache";
import { fakeSql, type FakeSqlHandler } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const own: SiteOwnership = { siteId: SITE, orgId: ORG, domains: ["acme.com"], pathPrefix: "/resources" };
const question = { id: "dddddddd-0000-0000-0000-000000000001", text: "Best SSO for startups?", locale: "us-en", device: "desktop" as const };
const chatgpt = answerEngines({}).find((e) => e.engine === "chatgpt")! as AnswerEngineConfig;
const DAY = "2026-10-13";

const probeResult = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  engine: "chatgpt",
  requestedModel: "openai/gpt-5-mini",
  model: "openai/gpt-5-mini-2026-08",
  text: "1. Okta is the default.\n2. Acme is ideal for startups.",
  citations: [
    { url: "https://acme.com/resources/sso", domain: "acme.com", title: "Acme", snippet: null, position: 1, positionInAnswer: 2, source: "annotation" },
    { url: "https://www.reddit.com/r/sso", domain: "reddit.com", title: null, snippet: null, position: 2, positionInAnswer: 1, source: "annotation" },
  ],
  citationSource: "annotation",
  citationsObservable: true,
  finishReason: "stop",
  nativeFinishReason: null,
  stopReason: "end_turn",
  usage: { inputTokens: 20, outputTokens: 400, costUsd: 0.012 },
  upstreamProvider: "OpenAI",
  responseId: "gen-1",
  fetchedAt: "2026-10-13T10:00:00.000Z",
  ...over,
});

function fakeGovernor(refuse = false) {
  const log: string[] = [];
  const requests: SpendRequest[] = [];
  const settled: number[] = [];
  const governor: SpendGovernor = {
    enabled: true,
    async reserve(req) {
      requests.push(req);
      log.push("reserve");
      if (refuse) throw new BudgetExceededError("answer_probe", req.orgId, 25, 25);
      return { id: "hold-1", orgId: req.orgId, siteId: req.siteId ?? null, resource: req.resource, estimateUsd: req.estimateUsd } satisfies Reservation;
    },
    async settle(_res, usd) {
      log.push("settle");
      settled.push(usd);
    },
    async release() {
      log.push("release");
    },
  };
  return { governor, log, requests, settled };
}

const entities: FakeSqlHandler = () => [
  { id: "e-brand", org_id: ORG, type: "brand", name: "Acme", aliases: [], wikidata_id: null, description: null },
  { id: "e-okta", org_id: ORG, type: "competitor", name: "Okta", aliases: [], wikidata_id: null, description: null },
];

function deps(over: Partial<SampleDeps> & { snapshot?: FakeSqlHandler } = {}) {
  const probes: string[] = [];
  const sql = fakeSql([
    [/insert into measure\.serp_snapshots/, over.snapshot ?? (() => [{ id: "snap-1" }])],
    [/select id from measure\.serp_snapshots/, () => [{ id: "snap-0" }]],
    [/from context\.entities e cross join lateral unnest/, () => []],
    [/from context\.entities where org_id/, entities],
  ]);
  const g = fakeGovernor();
  const d: SampleDeps = {
    sql,
    cache: memoryCache(),
    governor: g.governor,
    probe: async (cfg, prompt) => {
      probes.push(`${cfg.engine}:${prompt}`);
      return probeResult();
    },
    ...over,
  };
  return { d, sql, g, probes };
}

describe("sampleAnswer", () => {
  it("holds the answer probe budget, probes, settles at the reported cost, ledgers the call and records the answer", async () => {
    const { d, sql, g, probes } = deps();
    const out = await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "run-1", day: DAY }, d);
    expect(probes).toEqual(["chatgpt:Best SSO for startups?"]);
    expect(g.log).toEqual(["reserve", "settle"]);
    expect(g.requests[0]).toMatchObject({ orgId: ORG, siteId: SITE, resource: "answer_probe", estimateUsd: chatgpt.estimateUsd });
    expect(g.settled).toEqual([0.012]);
    expect(out).toMatchObject({ snapshotId: "snap-1", duplicate: false, cached: false, costUsd: 0.012, citations: 2, ownedCitations: 1, mentions: 2, brandMentioned: true, brandRecommended: true });

    const ledger = sql.queries.find((q) => q.text.startsWith("insert into ops.llm_calls"))!;
    expect(ledger.values.slice(0, 4)).toEqual([ORG, SITE, ANSWER_PROBE_TASK_KEY, "openai/gpt-5-mini-2026-08"]);
    expect(ledger.values.at(-1)).toBeNull();

    const snap = sql.queries.find((q) => q.text.startsWith("insert into measure.serp_snapshots"))!;
    expect(snap.text).toContain("'openrouter', $3, $4, 'api_probe'");
    expect(snap.text).toContain("on conflict (question_id, engine, sample_index, paraphrase_id, run_id) where collection_method = 'api_probe' and run_id is not null do nothing");
    expect(snap.values).toContain("openai/gpt-5-mini-2026-08+web:native");
    expect(snap.values).toContain(answerHash(probeResult().text));
    expect(snap.values.slice(0, 4)).toEqual([SITE, question.id, "chatgpt", "openai/gpt-5-mini-2026-08+web:native"]);

    const cites = sql.queries.filter((q) => q.text.startsWith("insert into measure.serp_citations"));
    expect(cites.map((c) => c.text.includes("'llm_answer'"))).toEqual([true, true]);
    // site, snapshot, url, domain, position, position in answer, owned, content, title, snippet, role, entity
    expect(cites.map((c) => [c.values[3], c.values[4], c.values[5], c.values[6], c.values[10]])).toEqual([
      ["acme.com", 1, 2, true, "owned"],
      ["reddit.com", 2, 1, false, "ugc_forum"],
    ]);

    const mentions = sql.queries.filter((q) => q.text.startsWith("insert into measure.answer_mentions"));
    expect(mentions.map((m) => [m.values[2], m.values[3], m.values[7], m.values[9], m.values[10]])).toEqual([
      ["e-okta", false, 1, true, "mentions-v0"],
      ["e-brand", true, 2, true, "mentions-v0"],
    ]);
  });

  it("re-reads the day's answer from the cache: no hold, no probe, no new spend", async () => {
    const { d, g, probes } = deps();
    await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "run-1", day: DAY }, d);
    const again = await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "run-2", day: DAY }, d);
    expect(probes).toHaveLength(1);
    expect(g.log).toEqual(["reserve", "settle"]);
    expect(again).toMatchObject({ cached: true, costUsd: 0 });
    // Another sample of the same prompt is another answer, and so is the same sample on another day.
    await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 1, runId: "run-2", day: DAY }, d);
    expect(probes).toHaveLength(2);
    await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "run-3", day: "2026-10-20" }, d);
    expect(probes).toHaveLength(3);
  });

  it("settles at the estimate when OpenRouter reports no cost", async () => {
    const { d, g } = deps({ probe: async () => probeResult({ usage: { inputTokens: 1, outputTokens: 1, costUsd: null } }) });
    await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "r", day: DAY }, d);
    expect(g.settled).toEqual([chatgpt.estimateUsd]);
  });

  it("gives the hold back when the probe fails, and records nothing", async () => {
    const { d, sql, g } = deps({
      probe: async () => {
        throw new AnswerProbeError("chatgpt", 503, "upstream");
      },
    });
    await expect(sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "r", day: DAY }, d)).rejects.toThrow(/upstream/);
    expect(g.log).toEqual(["reserve", "release"]);
    expect(sql.queries.some((q) => /insert into (ops\.llm_calls|measure\.serp_snapshots)/.test(q.text))).toBe(false);
  });

  it("pays nothing when the budget is spent", async () => {
    const refusing = fakeGovernor(true);
    const { d, probes } = deps({ governor: refusing.governor });
    const err = await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "r", day: DAY }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(probes).toEqual([]);
    expect(probeFailure(err, 0)).toBe("budget");
  });

  it("counts and ledgers a paid response with no answer in it, then throws it: never cached, never recorded", async () => {
    const empty: [Partial<ProbeResult>, boolean][] = [
      [{ text: "", finishReason: "length", stopReason: "max_tokens" }, true],
      [{ text: "", finishReason: "tool_calls", stopReason: "other" }, true],
      [{ text: "", finishReason: "error", stopReason: "other" }, false],
      [{ text: "Okta is", finishReason: "error", stopReason: "other" }, false],
    ];
    for (const [over, permanent] of empty) {
      const cache = memoryCache();
      let probes = 0;
      const { d, sql, g } = deps({ cache, probe: async () => (probes++, probeResult(over)) });
      const input = { own, question, engine: chatgpt, sampleIndex: 0, runId: "r", day: DAY };
      const err = (await sampleAnswer(input, d).then(() => null, (e: unknown) => e)) as AnswerProbeError;
      expect(err).toBeInstanceOf(AnswerProbeError);
      expect([err.permanent, probeFailure(err, 0)]).toEqual([permanent, permanent ? "skip" : "retry"]);
      expect(g.log).toEqual(["reserve", "settle"]);
      expect(g.settled).toEqual([0.012]);
      expect(sql.queries.filter((q) => q.text.startsWith("insert into ops.llm_calls"))).toHaveLength(1);
      expect(sql.queries.some((q) => q.text.startsWith("insert into measure.serp_snapshots"))).toBe(false);
      expect(cache.size).toBe(0);
      // Nothing was cached: the next attempt asks again.
      await sampleAnswer(input, d).catch(() => undefined);
      expect(probes).toBe(2);
    }
  });

  it("a step that paid and then failed to record keeps the answer as its own on the retry: no second probe, hold or ledger row", async () => {
    let blip = true;
    const { d, sql, g, probes } = deps({
      snapshot: () => {
        if (!blip) return [{ id: "snap-1" }];
        blip = false;
        throw new Error("db blip");
      },
    });
    const input = { own, question, engine: chatgpt, sampleIndex: 0, runId: "run-1", day: DAY };
    await expect(sampleAnswer(input, d)).rejects.toThrow(/db blip/);
    const again = await sampleAnswer(input, d);
    expect(probes).toHaveLength(1);
    // The hold is settled again on the retry, a no-op for a settled hold.
    expect(g.log).toEqual(["reserve", "settle", "settle"]);
    expect(g.requests).toHaveLength(1);
    expect(sql.queries.filter((q) => q.text.startsWith("insert into ops.llm_calls"))).toHaveLength(1);
    expect(again).toMatchObject({ snapshotId: "snap-1", duplicate: false, cached: false, costUsd: 0.012 });
    // site, question, engine, model, fetched, locale, cached, raw, cost…
    const snap = sql.queries.filter((q) => q.text.startsWith("insert into measure.serp_snapshots")).at(-1)!;
    expect([snap.values[6], snap.values[8]]).toEqual([false, 0.012]);
    // Another run the same day reads it free.
    expect(await sampleAnswer({ ...input, runId: "run-2" }, d)).toMatchObject({ cached: true, costUsd: 0 });
    // So does another question of the same run asking the same words.
    expect(await sampleAnswer({ ...input, question: { ...question, id: "dddddddd-0000-0000-0000-000000000002", locale: "gb-en" } }, d)).toMatchObject({ cached: true, costUsd: 0 });
    expect(g.log).toEqual(["reserve", "settle", "settle"]);
  });

  it("caches the answer before counting it: a settle or ledger write that fails is finished on the retry, the probe is not paid again", async () => {
    const flaky = fakeGovernor();
    let resets = 1;
    const governor: SpendGovernor = {
      ...flaky.governor,
      async settle(res, usd) {
        if (resets-- > 0) throw new Error("connection reset");
        await flaky.governor.settle(res, usd);
      },
    };
    const { d, sql, probes } = deps({ governor });
    const input = { own, question, engine: chatgpt, sampleIndex: 0, runId: "run-1", day: DAY };
    await expect(sampleAnswer(input, d)).rejects.toThrow(/connection reset/);
    expect(await sampleAnswer(input, d)).toMatchObject({ cached: false, costUsd: 0.012 });
    expect(probes).toHaveLength(1);
    expect(flaky.requests).toHaveLength(1);
    expect(flaky.settled).toEqual([0.012]);
    // The row landed on the first attempt (the settle's finally): not written twice.
    expect(sql.queries.filter((q) => q.text.startsWith("insert into ops.llm_calls"))).toHaveLength(1);

    let lost = true;
    const ledgerFails = deps();
    ledgerFails.d.sql = fakeSql([
      [/insert into ops\.llm_calls/, () => {
        if (!lost) return [];
        lost = false;
        throw new Error("ledger down");
      }],
      [/insert into measure\.serp_snapshots/, () => [{ id: "snap-1" }]],
      [/from context\.entities where org_id/, entities],
    ]);
    await expect(sampleAnswer(input, ledgerFails.d)).rejects.toThrow(/ledger down/);
    expect(await sampleAnswer(input, ledgerFails.d)).toMatchObject({ cached: false, costUsd: 0.012 });
    expect(ledgerFails.probes).toHaveLength(1);
    expect(ledgerFails.g.requests).toHaveLength(1);
    const ledger = (ledgerFails.d.sql as ReturnType<typeof fakeSql>).queries.filter((q) => q.text.startsWith("insert into ops.llm_calls"));
    expect(ledger).toHaveLength(2);
  });

  it("a step's paid answer stays its own when another org caches the same words before its retry", async () => {
    const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
    for (const fails of ["settle", "ledger"] as const) {
      // One cache for both orgs, as measure.serp_cache is; a later write replaces an earlier one.
      const cache = memoryCache();
      let down = true;
      const blip = (what: string) => {
        if (!down) return;
        down = false;
        throw new Error(`${what} down`);
      };
      const a = deps({ cache });
      const sqlA = fakeSql([
        [/insert into ops\.llm_calls/, () => (fails === "ledger" && blip("ledger"), [])],
        [/insert into measure\.serp_snapshots/, () => [{ id: "snap-a" }]],
        [/from context\.entities where org_id/, entities],
      ]);
      a.d.sql = sqlA;
      a.d.governor = { ...a.g.governor, settle: async (res, usd) => (fails === "settle" && blip("settle"), a.g.governor.settle(res, usd)) };
      // B's probe of the same words is in flight while A pays, and lands after A's answer was cached.
      let land!: () => void;
      const inFlight = new Promise<void>((r) => (land = r));
      let probing!: () => void;
      const bProbing = new Promise<void>((r) => (probing = r));
      const theirs = probeResult({ text: "Okta, mostly.", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 } });
      const b = deps({ cache, probe: async () => (probing(), await inFlight, theirs) });
      const bOwn: SiteOwnership = { siteId: "bbbbbbbb-0000-0000-0000-000000000001", orgId: OTHER_ORG, domains: ["globex.com"], pathPrefix: "/" };
      const bDone = sampleAnswer({ own: bOwn, question: { ...question, id: "dddddddd-0000-0000-0000-00000000000b" }, engine: chatgpt, sampleIndex: 0, runId: "run-b", day: DAY }, b.d);
      await bProbing;

      const input = { own, question, engine: chatgpt, sampleIndex: 0, runId: "run-a", day: DAY };
      await expect(sampleAnswer(input, a.d)).rejects.toThrow(`${fails} down`);
      land();
      expect(await bDone).toMatchObject({ cached: false, costUsd: 0.02 });

      // A's retry: its own paid answer, settled and ledgered once, not B's answer read free.
      expect(await sampleAnswer(input, a.d)).toMatchObject({ cached: false, costUsd: 0.012 });
      expect([a.probes.length, a.g.requests.length]).toEqual([1, 1]);
      expect(a.g.settled).toEqual(fails === "settle" ? [0.012] : [0.012, 0.012]);
      const ledger = sqlA.queries.filter((q) => q.text.startsWith("insert into ops.llm_calls"));
      expect(ledger.map((q) => q.values[0])).toEqual(fails === "ledger" ? [ORG, ORG] : [ORG]);
      const snap = sqlA.queries.filter((q) => q.text.startsWith("insert into measure.serp_snapshots")).at(-1)!;
      expect(snap.values).toContain(answerHash(probeResult().text));
      expect([snap.values[6], snap.values[8]]).toEqual([false, 0.012]);
      // Anyone else now reads B's answer, the later one, free.
      const later = deps({ cache });
      expect(await sampleAnswer({ ...input, runId: "run-c" }, later.d)).toMatchObject({ cached: true, costUsd: 0 });
      expect(later.probes).toEqual([]);
    }
  });

  it("writes nothing more when the step runs again after its row committed", async () => {
    const { d, sql } = deps({ snapshot: () => [] });
    const out = await sampleAnswer({ own, question, engine: chatgpt, sampleIndex: 0, runId: "run-1", day: DAY }, d);
    expect(out).toMatchObject({ snapshotId: "snap-0", duplicate: true, citations: 0, mentions: 0 });
    expect(sql.queries.some((q) => /insert into measure\.(serp_citations|answer_mentions)/.test(q.text))).toBe(false);
  });
});

describe("sampling plan", () => {
  it("skips a request the engine refused, retries a blip until the last attempt, and stops on a spent budget", () => {
    expect(probeFailure(new AnswerProbeError("chatgpt", 404, "no such model"), 0)).toBe("skip");
    expect(probeFailure(new AnswerProbeError("chatgpt", 503, "busy"), 0)).toBe("retry");
    expect(probeFailure(new AnswerProbeError("chatgpt", 429, "slow down"), 2)).toBe("skip");
    expect(probeFailure(new Error("db blip"), 1)).toBe("retry");
    expect(probeFailure(new BudgetExceededError("answer_probe", ORG, 25, 25), 2)).toBe("budget");
  });

  it("cuts the panel so a run stays within its step limit", () => {
    const panel = Array.from({ length: 100 }, (_, i) => i);
    expect(fitPanel(panel, 4, 1)).toHaveLength(100);
    expect(fitPanel(panel, 4, 3)).toHaveLength(Math.floor(MAX_PROBE_STEPS / 12));
    expect(fitPanel(panel, 0, 0)).toHaveLength(100);
  });

  it("the panel is tracked, not excluded, pinned first, then by demand", async () => {
    const sql = fakeSql();
    await loadAnswerPanel(SITE, 25, sql);
    expect(sql.queries[0]!.text).toContain("where site_id = $1 and is_tracked and not excluded order by pinned desc, demand_score desc, seen_count desc, id limit $2");
  });

  it("samples only orgs with the feature on, on tracked sites with a panel", async () => {
    const sql = fakeSql();
    await sitesForAnswerProbes(null, sql);
    const q = sql.queries[0]!;
    expect(q.text).toContain("app.org_feature_enabled(o.id, $5)");
    expect(q.text).toContain("exists (select 1 from measure.questions q where q.site_id = s.id and q.is_tracked and not q.excluded)");
    expect(q.values).toEqual([null, null, ["provisioning", "verifying", "active"], ["trialing", "active", "past_due"], ANSWER_PROBES_FEATURE]);
  });
});

describe("engine visibility", () => {
  it("reads probes only, one per prompt, engine, sample and day, from the answer view", async () => {
    const sql = fakeSql();
    await engineVisibility(SITE, { days: 28 }, sql);
    for (const q of sql.queries) {
      expect(q.text).toContain("from measure.v_answer_observations o");
      expect(q.text).toContain("o.collection_method = 'api_probe'");
      expect(q.text).toContain("select distinct on (o.question_id, o.engine, o.sample_index, o.paraphrase_id, (o.fetched_at at time zone 'utc')::date)");
      expect(q.text).not.toContain("v_native_aio");
    }
    expect(sql.queries[0]!.text).toContain("count(*) filter (where o.citations_observable and exists ( select 1 from measure.serp_citations c where c.serp_snapshot_id = o.id and c.is_owned))::int as cited");
  });

  it("turns counts into shares with intervals; citation share is over observable answers only", () => {
    const [chat, claude] = summarizeEngines(
      [
        { engine: "claude", n: 10, mentioned: 4, recommended: 2, n_observable: 0, cited: 0, model_versions: ["anthropic/claude-sonnet-5.5+web:native"], last_observed_at: null },
        { engine: "chatgpt", n: 40, mentioned: 20, recommended: 10, n_observable: 20, cited: 5, model_versions: null, last_observed_at: null },
      ],
      [{ engine: "chatgpt", entity_id: "e-okta", name: "Okta", mentioned: 30, recommended: 16 }],
      (e) => e.toUpperCase(),
    );
    expect(chat).toMatchObject({ engine: "chatgpt", label: "CHATGPT", n: 40, lowN: false, nObservable: 20, modelVersions: [] });
    expect([chat!.mention.p, chat!.recommendation.p, chat!.citation.p, chat!.citation.n]).toEqual([0.5, 0.25, 0.25, 20]);
    expect(chat!.competitors).toEqual([{ entity_id: "e-okta", name: "Okta", mentioned: 30, recommendation: expect.objectContaining({ k: 16, n: 40, p: 0.4 }) }]);
    expect(claude).toMatchObject({ engine: "claude", lowN: true, nObservable: 0, competitors: [] });
    expect(claude!.citation).toEqual({ k: 0, n: 0, p: null, low: null, high: null });
  });
});
