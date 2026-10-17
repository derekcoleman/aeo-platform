import { describe, expect, it } from "vitest";
import { runCompetitorGap, type CompetitorGapDeps } from "@/lib/inngest/strategy";
import { BudgetExceededError } from "@/lib/ops/spend";
import { checkCoverage, rankedPageOf } from "@/lib/pipeline/coverage";
import type { EV0Breakdown } from "@/lib/pipeline/opportunities";
import type { RankedKeyword, RankedKeywordsResult } from "@/lib/serp/dataforseo-labs";
import { SerpProviderError } from "@/lib/serp/types";
import {
  computeOrganicGap,
  domainLabel,
  GAP_OPPORTUNITIES,
  gapEvidence,
  gapFetchFailure,
  gapMarketSupported,
  loadGapPlan,
  marketOf,
  MAX_GAP_COMPETITORS,
  namesAny,
  persistOrganicGap,
  type DomainKeywords,
  type GapPlan,
  type GapTarget,
  type OrganicGap,
  type PersistGapInput,
} from "@/lib/strategy/competitor-gap";
import { fakeSql, type FakeSqlHandler, type RecordedQuery } from "./helpers/fake-sql";
import { ORG_ID, SITE_ID } from "./fixtures/pipeline";

const OKTA = "eeeeeeee-2000-0000-0000-000000000002";
const AUTH0 = "eeeeeeee-2000-0000-0000-000000000004";

const kw = (keyword: string, rank: number, over: Partial<RankedKeyword> = {}): RankedKeyword => ({
  keyword,
  searchVolume: 100,
  keywordDifficulty: 30,
  searchIntent: "informational",
  rank,
  url: `https://example.com/${keyword.replace(/\s+/g, "-")}`,
  ...over,
});
const target = (domain: string, entityId: string, name: string, keywords: RankedKeyword[]): DomainKeywords & GapTarget => ({ domain, entityId, name, truncated: false, keywords });

const own: DomainKeywords = {
  domain: "acme.com",
  truncated: false,
  keywords: [
    kw("scim provisioning", 4, { searchVolume: 720 }),
    kw("sso pricing", 14, { searchVolume: 880, url: "https://acme.com/resources/sso-pricing" }),
  ],
};
const okta = target("okta.com", OKTA, "Okta", [
  kw("scim provisioning", 2, { searchVolume: 720, searchIntent: "commercial" }),
  kw("sso pricing", 3, { searchVolume: 880, searchIntent: "commercial" }),
  kw("what is saml", 1, { searchVolume: 9900 }),
  kw("okta login", 1, { searchVolume: 200_000, searchIntent: "navigational" }),
  kw("okta alternatives", 5, { searchVolume: 2400, searchIntent: "commercial" }),
  kw("best sso software", 6, { searchVolume: 1600, searchIntent: "commercial" }),
  kw("deep page keyword", 15, { searchVolume: 50_000 }),
]);
const auth0 = target("auth0.com", AUTH0, "Auth0", [
  kw("what is saml", 4, { searchVolume: 9900 }),
  kw("Best SSO software", 2, { searchVolume: 1600, searchIntent: "commercial" }),
  kw("jwt decoder", 1, { searchVolume: 40_000, searchIntent: "navigational" }),
]);

describe("computeOrganicGap", () => {
  const gap = computeOrganicGap(own, [okta, auth0], { brandedTerms: ["Okta", "auth0"] });

  it("keeps keywords a competitor ranks top 10 for and the site does not, buyer intent first, then volume", () => {
    expect(gap.rows.map((r) => r.keyword)).toEqual(["okta alternatives", "best sso software", "sso pricing", "what is saml", "jwt decoder"]);
    expect(gap.covered).toBe(1);
    expect(gap.branded).toBe(1);
    expect(gap.unknown).toBe(0);
  });

  it("merges the competitors that rank for a keyword, best rank first", () => {
    expect(gap.rows.find((r) => r.keyword === "best sso software")!.competitors).toEqual([
      { entityId: AUTH0, name: "Auth0", domain: "auth0.com", rank: 2, url: "https://example.com/Best-SSO-software" },
      { entityId: OKTA, name: "Okta", domain: "okta.com", rank: 6, url: "https://example.com/best-sso-software" },
    ]);
    expect(gap.rows.find((r) => r.keyword === "what is saml")!.competitors.map((c) => [c.domain, c.rank])).toEqual([["okta.com", 1], ["auth0.com", 4]]);
  });

  it("flags 11–20 as striking distance, with the page that ranks", () => {
    expect(gap.rows.find((r) => r.keyword === "sso pricing")).toMatchObject({ brandRank: 14, brandUrl: "https://acme.com/resources/sso-pricing", strikingDistance: true });
    expect(gap.rows.find((r) => r.keyword === "what is saml")).toMatchObject({ brandRank: null, brandUrl: null, strikingDistance: false });
  });

  it("drops a keyword naming a competitor unless it compares, and ranks past 10", () => {
    expect(gap.rows.some((r) => r.keyword === "okta login")).toBe(false);
    expect(gap.rows.some((r) => r.keyword === "okta alternatives")).toBe(true);
    expect(gap.rows.some((r) => r.keyword === "deep page keyword")).toBe(false);
  });

  it("does not report a gap the site's cut list cannot rule out", () => {
    const cut: DomainKeywords = { domain: "acme.com", truncated: true, keywords: [kw("scim guide", 3, { searchVolume: 5000 }), kw("scim spec", 9, { searchVolume: 1000 })] };
    const rival = target("okta.com", OKTA, "Okta", [kw("scim api", 2, { searchVolume: 4000 }), kw("scim rfc", 2, { searchVolume: 1000 }), kw("scim faq", 2, { searchVolume: null })]);
    const g = computeOrganicGap(cut, [rival]);
    expect(g.rows.map((r) => r.keyword)).toEqual(["scim api"]);
    expect(g.unknown).toBe(2);
    // A complete list rules them all in.
    expect(computeOrganicGap({ ...cut, truncated: false }, [rival]).rows).toHaveLength(3);
  });

  it("caps the rows kept", () => {
    expect(computeOrganicGap(own, [okta, auth0], { limit: 2 }).rows).toHaveLength(2);
  });

  it("names, labels and markets", () => {
    expect(namesAny("okta vs entra", ["okta"])).toBe(true);
    expect(namesAny("oktane conference", ["okta"])).toBe(false);
    expect(namesAny("a box", ["ab"])).toBe(false);
    expect(domainLabel("login.auth0.com")).toBe("auth0");
    expect(domainLabel("okta.com")).toBe("okta");
    // A second-level label under a country code is the registry's, not the name.
    expect(domainLabel("canva.com.au")).toBe("canva");
    expect(domainLabel("bbc.co.uk")).toBe("bbc");
    expect(domainLabel("news.example.ne.jp")).toBe("example");
    expect(domainLabel("acme.co")).toBe("acme");
    expect(domainLabel("app.go.com")).toBe("go");
    expect(domainLabel("localhost")).toBe("localhost");
    expect(marketOf("en-US")).toEqual({ country: "us", language: "en" });
    expect(marketOf("de-DE")).toEqual({ country: "de", language: "de" });
    expect(marketOf("pt_BR")).toEqual({ country: "br", language: "pt" });
    expect(marketOf("en")).toEqual({ country: "us", language: "en" });
    expect(marketOf("")).toEqual({ country: "us", language: "en" });
    expect(gapMarketSupported(marketOf("en-US"))).toBe(true);
    expect(gapMarketSupported(marketOf("de-DE"))).toBe(true);
    expect(gapMarketSupported(marketOf("pt_BR"))).toBe(true);
    for (const locale of ["ja-JP", "ru-RU", "zh-CN", "ko-KR", "el-GR", "ar-SA", "he-IL", "vi-VN"]) expect(gapMarketSupported(marketOf(locale))).toBe(false);
  });

  it("keys keywords as measure.questions does: one in another script has no key and is not a gap", () => {
    const rival = target("rival.jp", OKTA, "Rival", [kw("シングルサインオン 料金", 2, { searchVolume: 900 }), kw("единый вход цена", 3, { searchVolume: 800 }), kw("sso pricing", 4)]);
    expect(computeOrganicGap({ domain: "acme.jp", truncated: false, keywords: [] }, [rival]).rows.map((r) => r.keyword)).toEqual(["sso pricing"]);
  });
});

describe("gapFetchFailure", () => {
  it("stops on a spent budget, skips what the vendor refused, retries the rest until the last attempt", () => {
    expect(gapFetchFailure(new BudgetExceededError("serp", ORG_ID, 25, 25), 0)).toBe("budget");
    expect(gapFetchFailure(new SerpProviderError("dataforseo", "Invalid Field", 40501), 0)).toBe("skip");
    expect(gapFetchFailure(new SerpProviderError("dataforseo", "404", 404), 0)).toBe("skip");
    expect(gapFetchFailure(new SerpProviderError("dataforseo", "Internal Error", 50000), 0)).toBe("retry");
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(gapFetchFailure(timeout, 0)).toBe("retry");
    expect(gapFetchFailure(timeout, 2)).toBe("skip");
  });
});

describe("loadGapPlan", () => {
  const siteRow = (over: Record<string, unknown> = {}) => [/from app\.sites s join app\.organizations o/, () => [{ canonical_domain: "www.acme.com", locale: "en-US", status: "active", plan_status: "active", org_id: ORG_ID, ...over }]] as [RegExp, FakeSqlHandler];
  const domains: [RegExp, FakeSqlHandler] = [/from app\.site_domains/, () => [{ hostname: "acme.io" }]];
  const entities = (rows: unknown[]): [RegExp, FakeSqlHandler] => [/from context\.entities e/, () => rows];
  const NOW = new Date("2026-10-17T09:00:00Z");

  it("asks about the named competitors' domains, confirmed and most cited first, never the site's own, at most five", async () => {
    const sql = fakeSql([
      siteRow(),
      domains,
      entities([
        { id: OKTA, name: "Okta", aliases: ["Okta Workforce"], domains: ["okta.com", "auth0.com"] },
        { id: "e2", name: "Acme Labs", aliases: [], domains: ["acme.io"] },
        { id: "e3", name: "OneLogin", aliases: [], domains: ["onelogin.com"] },
        { id: "e4", name: "JumpCloud", aliases: [], domains: ["jumpcloud.com", "okta.com"] },
        { id: "e5", name: "Ping", aliases: [], domains: ["pingidentity.com"] },
        { id: "e6", name: "Duo", aliases: [], domains: ["duo.com"] },
        { id: "e7", name: "Entra", aliases: [], domains: [] },
        { id: "e8", name: "Canva Pty", aliases: [], domains: ["canva.com.au"] },
      ]),
    ]);
    const r = await loadGapPlan(SITE_ID, ORG_ID, sql, NOW);
    if (!("plan" in r)) throw new Error("expected a plan");
    expect(r.plan.competitors.map((c) => c.domain)).toEqual(["okta.com", "auth0.com", "onelogin.com", "jumpcloud.com", "pingidentity.com"]);
    expect(r.plan.competitors).toHaveLength(MAX_GAP_COMPETITORS);
    expect(r.plan.competitors[1]).toEqual({ domain: "auth0.com", entityId: OKTA, name: "Okta" });
    expect(r.plan).toMatchObject({ siteId: SITE_ID, orgId: ORG_ID, brand: "acme.com", market: { country: "us", language: "en" }, locale: "us-en", month: "2026-10" });
    // Every competitor's names and domain labels, the ones past the cap included.
    expect(r.plan.brandedTerms).toEqual(expect.arrayContaining(["okta", "okta workforce", "auth0", "onelogin", "duo", "entra", "canva"]));
    // A registry's label is no one's brand: "best com domain registrar" stays a gap.
    expect(r.plan.brandedTerms).not.toContain("com");
    expect(namesAny("best com domain registrar", r.plan.brandedTerms)).toBe(false);
    const q = sql.queries.find((x) => x.text.includes("from context.entities e"))!;
    expect(q.text).toContain("e.type = 'competitor'");
    expect(q.text).toContain("(e.metadata ? 'seeded_from')");
    expect(q.text).toContain("measure.v_native_aio");
  });

  it("skips a site that is not tracked, another org's site, and an org without a competitor domain", async () => {
    expect(await loadGapPlan(SITE_ID, ORG_ID, fakeSql([siteRow({ status: "paused" })]), NOW)).toEqual({ skipped: "site is paused" });
    expect(await loadGapPlan(SITE_ID, ORG_ID, fakeSql([siteRow({ plan_status: "canceled" })]), NOW)).toEqual({ skipped: "plan is canceled" });
    expect(await loadGapPlan(SITE_ID, ORG_ID, fakeSql([siteRow({ org_id: "22222222-2222-2222-2222-222222222222" })]), NOW)).toEqual({ skipped: "site not found" });
    expect(await loadGapPlan(SITE_ID, ORG_ID, fakeSql([siteRow(), domains, entities([{ id: "e7", name: "Entra", aliases: [], domains: [] }])]), NOW)).toEqual({ skipped: "no named competitor with a domain" });
  });

  it("skips a market whose keywords it cannot read before anything is paid for", async () => {
    const sql = fakeSql([siteRow({ locale: "ja-JP" }), domains, entities([{ id: OKTA, name: "Okta", aliases: [], domains: ["okta.com"] }])]);
    expect(await loadGapPlan(SITE_ID, ORG_ID, sql, NOW)).toEqual({ skipped: "market jp-ja: keywords outside the Latin alphabet are not read" });
    expect(sql.queries).toHaveLength(1);
  });
});

describe("persistOrganicGap", () => {
  const TOPIC = "tttttttt-0000-0000-0000-000000000001";
  const gap = computeOrganicGap(own, [okta, auth0], { brandedTerms: ["okta", "auth0"] });
  const input = (g: OrganicGap = gap, over: Partial<PersistGapInput> = {}): PersistGapInput => ({
    siteId: SITE_ID, locale: "us-en", gap: g, fetchedDomains: ["okta.com", "auth0.com"], plannedDomains: ["okta.com", "auth0.com", "onelogin.com"], fetchedAt: "2026-10-02T11:00:00.000Z", ...over,
  });
  const jsonRows = (q: RecordedQuery) => (q.values.find((v) => v && typeof v === "object" && "__json" in v) as { __json: Record<string, unknown>[] }).__json;

  /** A site whose SSO topic seeds "sso" and "saml"; "excluded" names the normalised keywords a person excluded. */
  function db(excluded: string[] = []) {
    const questions = new Map<string, { id: string; text: string; volume: number | null; intent: string | null; topic: string | null }>();
    return fakeSql([
      [/from measure\.topics/, () => [{ id: TOPIC, priority: 4, formats: ["comparison"], status: "active", name: "SSO", seed_terms: ["sso", "saml"] }]],
      [/insert into measure\.questions as q/, (q) =>
        jsonRows(q).map((r) => {
          const id = `q-${String(r.normalized).replace(/\s+/g, "-")}`;
          questions.set(id, { id, text: String(r.text), volume: r.search_volume as number | null, intent: r.search_intent as string | null, topic: r.topic_id as string | null });
          return { id, normalized: r.normalized, excluded: excluded.includes(String(r.normalized)), topic_id: r.topic_id };
        })],
      [/insert into measure\.competitor_keywords/, (q) => jsonRows(q).map((_, i) => ({ id: `k${i}` }))],
      [/from measure\.questions q\s+where q\.site_id/, (q) =>
        ((q.values[1] as { __array: string[] }).__array).flatMap((id) => {
          const row = questions.get(id);
          return row ? [{ id, text: row.text, topic_id: row.topic, demand_score: 10, search_volume: row.volume, search_intent: row.intent, query_impressions: null }] : [];
        })],
      [/from app\.sites where id/, () => [{ org_id: ORG_ID, keywords: ["single sign-on"], profile_keywords: null }]],
      [/from context\.entities where org_id/, () => [{ id: OKTA, org_id: ORG_ID, type: "competitor", name: "Okta", aliases: [], wikidata_id: null, description: null }]],
      [/insert into content\.opportunities/, () => [{ inserted: true }]],
    ]);
  }

  it("files the keywords as competitor questions with their volume, difficulty, intent and topic", async () => {
    const sql = db();
    const out = await persistOrganicGap(input(), sql);
    const insert = sql.queries.find((q) => q.text.includes("insert into measure.questions as q"))!;
    expect(insert.text).toContain("'competitor'");
    expect(insert.text).toContain("on conflict (site_id, normalized, locale, device) do update set");
    // An existing question keeps its source, tracking and exclusion: none of them is set on conflict.
    expect(insert.text).not.toMatch(/do update set[^]*\b(source|is_tracked|excluded|tracking_tier|demand_score) =/);
    // Discovery's demand score is left alone: a keyword's demand is its volume.
    expect(insert.text).not.toContain("demand_score");
    expect(insert.values).toContain("us-en");
    expect(jsonRows(insert).find((r) => r.normalized === "sso pricing")).toEqual({
      text: "sso pricing", normalized: "sso pricing", seed_term: "okta.com", search_volume: 880, keyword_difficulty: 30, search_intent: "commercial", topic_id: TOPIC,
    });
    expect(jsonRows(insert).find((r) => r.normalized === "jwt decoder")!.topic_id).toBeNull();
    expect(out.questions).toBe(5);
  });

  it("replaces the fetched domains' rows and drops domains the run no longer covers, keeping a failed fetch's", async () => {
    const sql = db();
    const out = await persistOrganicGap(input(), sql);
    const del = sql.queries.find((q) => q.text.startsWith("delete from measure.competitor_keywords"))!;
    expect(del.text).toContain("domain = any ($2::text[]) or domain <> all ($3::text[])");
    expect(del.values).toEqual([SITE_ID, ["okta.com", "auth0.com"], ["okta.com", "auth0.com", "onelogin.com"]]);
    const ins = sql.queries.find((q) => q.text.includes("insert into measure.competitor_keywords"))!;
    expect(ins.text).toContain("e.type = 'competitor'");
    const rows = jsonRows(ins);
    // One row per keyword and competitor domain that ranks for it.
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.keyword === "sso pricing")).toEqual({
      entity_id: OKTA, domain: "okta.com", keyword: "sso pricing", question_id: "q-sso-pricing", rank: 3, url: "https://example.com/sso-pricing",
      search_volume: 880, keyword_difficulty: 30, search_intent: "commercial", brand_rank: 14, brand_url: "https://acme.com/resources/sso-pricing",
    });
    expect(out.keywords).toBe(7);
  });

  it("opens EV0 opportunities above the topical floor, not for excluded questions", async () => {
    const sql = db(["what is saml"]);
    const out = await persistOrganicGap(input(), sql);
    const opps = sql.queries.filter((q) => q.text.startsWith("insert into content.opportunities"));
    // jwt decoder ties to nothing on the site; what is saml was excluded.
    expect(out.opportunities).toMatchObject({ considered: 4, belowFloor: 1, inserted: 3 });
    // Highest EV first: the SSO topic's keywords outrank a comparison on no topic that only names a rival.
    expect(opps.map((q) => q.values[2])).toEqual(["best sso software", "sso pricing", "okta alternatives"]);
    // No topic: its topic_id is null.
    expect(opps.find((q) => q.values[2] === "okta alternatives")!.values[7]).toBeNull();
    expect(opps.find((q) => q.values[2] === "sso pricing")!.values[7]).toBe(TOPIC);
    const sso = opps.find((q) => q.values[2] === "sso pricing")!;
    expect(sso.values[1]).toBe("competitor");
    expect(sso.values[4]).toBe("q-sso-pricing");
    expect(sso.values).toContain("question:q-sso-pricing");
    const breakdown = (sso.values.find((v) => (v as { __json?: { formula?: string } })?.__json?.formula === "ev0") as { __json: EV0Breakdown }).__json;
    expect(breakdown.components.gap).toEqual({ type: "organic_competitor", prior: 0.4 });
    expect(breakdown.components.demand).toMatchObject({ source: "search_volume", input: 880 });
    expect(breakdown.components.effort.action).toBe("new_page");
    const evidence = (sso.values.find((v) => (v as { __json?: { kind?: string } })?.__json?.kind === "organic_competitor") as { __json: Record<string, unknown> }).__json;
    expect(evidence).toMatchObject({ source: "dataforseo_labs", keyword: "sso pricing", brandRank: 14, brandUrl: "https://acme.com/resources/sso-pricing", strikingDistance: true });
    expect(evidence.competitors).toEqual([{ name: "Okta", domain: "okta.com", rank: 3, url: "https://example.com/sso-pricing" }]);
  });

  it("opens at most GAP_OPPORTUNITIES, the highest EV first", async () => {
    const many = target("okta.com", OKTA, "Okta", Array.from({ length: GAP_OPPORTUNITIES + 10 }, (_, i) => kw(`sso question ${i}`, 3, { searchVolume: 100 + i })));
    const sql = db();
    const out = await persistOrganicGap(input(computeOrganicGap({ domain: "acme.com", truncated: false, keywords: [] }, [many])), sql);
    const opps = sql.queries.filter((q) => q.text.startsWith("insert into content.opportunities"));
    expect(out.opportunities).toMatchObject({ considered: GAP_OPPORTUNITIES + 10, inserted: GAP_OPPORTUNITIES });
    expect(opps[0]!.values[2]).toBe(`sso question ${GAP_OPPORTUNITIES + 9}`);
    const scores = opps.map((q) => q.values[9] as number);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("an empty gap still clears the fetched domains' rows", async () => {
    const sql = db();
    const out = await persistOrganicGap(input({ rows: [], covered: 0, branded: 0, unknown: 0 }), sql);
    expect(sql.queries.map((q) => q.text.split(" ").slice(0, 3).join(" "))).toEqual(["select id, priority,", "delete from measure.competitor_keywords"]);
    expect(out).toEqual({ questions: 0, keywords: 0, opportunities: { inserted: 0, updated: 0, considered: 0, belowFloor: 0 } });
  });

  it("evidence carries the top three competitors only", () => {
    const row = { ...gap.rows[0]!, competitors: ["a.com", "b.com", "c.com", "d.com"].map((domain, i) => ({ entityId: OKTA, name: domain, domain, rank: i + 1, url: null })) };
    expect((gapEvidence(row, { locale: "us-en", fetchedAt: "t" }).competitors as unknown[]).length).toBe(3);
  });
});

describe("runCompetitorGap", () => {
  const plan: GapPlan = {
    siteId: SITE_ID, orgId: ORG_ID, brand: "acme.com", market: { country: "us", language: "en" }, locale: "us-en",
    competitors: [{ domain: "okta.com", entityId: OKTA, name: "Okta" }, { domain: "auth0.com", entityId: AUTH0, name: "Auth0" }, { domain: "onelogin.com", entityId: "e3", name: "OneLogin" }],
    brandedTerms: ["okta", "auth0", "onelogin"], month: "2026-10",
  };
  const result = (domain: string, keywords: RankedKeyword[], over: Partial<RankedKeywordsResult & { cached: boolean }> = {}): RankedKeywordsResult & { cached: boolean } => ({
    provider: "dataforseo", target: domain, locationCode: 2840, languageCode: "en", localeFallback: false, maxRank: 10, total: keywords.length, truncated: false,
    keywords, fetchedAt: "2026-10-02T11:00:00.000Z", costUsd: 0.11, cached: false, ...over,
  });

  /** A stand-in for Inngest's step: run executes and round-trips JSON, as memoisation does; pass an earlier attempt's memo to replay it. */
  function fakeStep(memo = new Map<string, unknown>()) {
    const log: string[] = [];
    const step = {
      async run(id: string, fn: () => unknown) {
        log.push(id);
        if (memo.has(id)) return memo.get(id);
        const v = await fn();
        const out = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
        memo.set(id, out);
        return out;
      },
    };
    return { step: step as unknown as Parameters<typeof runCompetitorGap>[0], log, memo };
  }

  function deps(outcomes: Record<string, RankedKeywordsResult & { cached: boolean } | Error>, over: Partial<CompetitorGapDeps> = {}) {
    const asked: string[] = [];
    const persisted: PersistGapInput[] = [];
    const d: CompetitorGapDeps = {
      configured: () => true,
      loadPlan: async () => ({ plan }),
      rankedKeywords: async (_plan, domain, maxRank) => {
        asked.push(`${domain}:${maxRank}`);
        const o = outcomes[domain];
        if (!o) throw new Error(`unexpected ${domain}`);
        if (o instanceof Error) throw o;
        return o;
      },
      persist: async (input) => {
        persisted.push(input);
        return { questions: input.gap.rows.length, keywords: input.gap.rows.length, opportunities: { inserted: 1, updated: 0, considered: 1, belowFloor: 0 } };
      },
      ...over,
    };
    return { d, asked, persisted };
  }

  const ok = {
    "acme.com": result("acme.com", own.keywords, { maxRank: 20 }),
    "okta.com": result("okta.com", okta.keywords),
    "auth0.com": result("auth0.com", auth0.keywords, { cached: true }),
    "onelogin.com": result("onelogin.com", [kw("saml sso setup", 2, { searchVolume: 300 })]),
  };

  it("reads the site's own rankings to 20, each competitor's to 10, one step each, then stores the gap", async () => {
    const { step, log } = fakeStep();
    const { d, asked, persisted } = deps(ok);
    const out = await runCompetitorGap(step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, d);
    expect(log).toEqual(["load-plan", "ranked:own", "ranked:okta.com", "ranked:auth0.com", "ranked:onelogin.com", "persist"]);
    expect(asked).toEqual(["acme.com:20", "okta.com:10", "auth0.com:10", "onelogin.com:10"]);
    expect(persisted[0]).toMatchObject({ siteId: SITE_ID, locale: "us-en", fetchedDomains: ["okta.com", "auth0.com", "onelogin.com"], plannedDomains: ["okta.com", "auth0.com", "onelogin.com"] });
    expect(persisted[0]!.gap.rows.map((r) => r.keyword)).toEqual(["okta alternatives", "best sso software", "sso pricing", "what is saml", "saml sso setup", "jwt decoder"]);
    // A cached read costs nothing.
    expect(out).toMatchObject({ competitors: 3, failed: 0, cached: 1, budgetStopped: false, gap: { keywords: 6, covered: 1, branded: 1, unknown: 0 } });
    expect((out as { costUsd: number }).costUsd).toBeCloseTo(0.33);
  });

  it("skips a competitor the vendor refused and keeps going; its old rows stay", async () => {
    const { step } = fakeStep();
    const { d, persisted } = deps({ ...ok, "auth0.com": new SerpProviderError("dataforseo", "Invalid Field: 'target'.", 40501) });
    const out = await runCompetitorGap(step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, d);
    expect(out).toMatchObject({ competitors: 2, failed: 1 });
    expect(persisted[0]!.fetchedDomains).toEqual(["okta.com", "onelogin.com"]);
    expect(persisted[0]!.plannedDomains).toContain("auth0.com");
  });

  it("a spent budget stops the fetches and stores what was fetched", async () => {
    const { step, log } = fakeStep();
    const { d, persisted } = deps({ ...ok, "auth0.com": new BudgetExceededError("serp", ORG_ID, 25, 25) });
    const out = await runCompetitorGap(step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, d);
    expect(log).not.toContain("ranked:onelogin.com");
    expect(out).toMatchObject({ competitors: 1, budgetStopped: true });
    expect(persisted[0]!.fetchedDomains).toEqual(["okta.com"]);
  });

  it("without the site's own rankings there is no gap: nothing is fetched or stored after", async () => {
    const { step, log } = fakeStep();
    const { d, persisted } = deps({ ...ok, "acme.com": new SerpProviderError("dataforseo", "Invalid Field: 'location_code'.", 40501) });
    expect(await runCompetitorGap(step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, d)).toMatchObject({ stopped: "own rankings unavailable" });
    expect(log).toEqual(["load-plan", "ranked:own"]);
    expect(persisted).toHaveLength(0);
  });

  it("a transient failure is retried by Inngest, and a retry does not pay again for the steps that finished", async () => {
    const first = fakeStep();
    const flaky = deps({ ...ok, "auth0.com": new SerpProviderError("dataforseo", "Internal Error.", 50000) });
    await expect(runCompetitorGap(first.step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, flaky.d)).rejects.toThrow(/Internal Error/);
    const second = fakeStep(first.memo);
    const healed = deps(ok);
    const out = await runCompetitorGap(second.step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 1 }, healed.d);
    expect(healed.asked).toEqual(["auth0.com:10", "onelogin.com:10"]);
    expect(out).toMatchObject({ competitors: 3 });
    // On the last attempt the same failure is skipped instead.
    const last = deps({ ...ok, "auth0.com": new SerpProviderError("dataforseo", "Internal Error.", 50000) });
    expect(await runCompetitorGap(fakeStep().step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 2 }, last.d)).toMatchObject({ competitors: 2, failed: 1 });
  });

  it("does nothing without DataForSEO, or when the plan says to skip", async () => {
    const { step, log } = fakeStep();
    expect(await runCompetitorGap(step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, deps(ok, { configured: () => false }).d)).toEqual({ skipped: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set" });
    expect(log).toEqual([]);
    expect(await runCompetitorGap(step, { siteId: SITE_ID, orgId: ORG_ID, attempt: 0 }, deps(ok, { loadPlan: async () => ({ skipped: "site is paused" }) }).d)).toEqual({ skipped: "site is paused" });
  });
});

describe("coverage guard: a page already in striking distance", () => {
  const CMS = "cccccccc-7000-0000-0000-000000000001";
  const ITEM = "cccccccc-7000-0000-0000-000000000002";
  const evidence = { brandUrl: "https://acme.com/blog/sso-pricing", brandRank: 14 };
  const opp = { site_id: SITE_ID, source: "competitor" as const, question_id: "q-sso-pricing", title: "sso pricing", target_query: "sso pricing", evidence };
  const ranked = (row: Record<string, unknown> | null): [RegExp, FakeSqlHandler] => [/from \(select content\.url_key\(/, () => (row ? [row] : [])];

  it("reads the ranking page from the competitor gap's own evidence", () => {
    expect(rankedPageOf(opp)).toEqual({ url: "https://acme.com/blog/sso-pricing", rank: 14 });
    expect(rankedPageOf({ source: "competitor", evidence: { brandUrl: "", brandRank: 14 } })).toBeNull();
    expect(rankedPageOf({ source: "competitor", evidence: { snapshotId: "s1" } })).toBeNull();
    expect(rankedPageOf({ source: "competitor", evidence: { brandUrl: "https://acme.com/x" } })).toEqual({ url: "https://acme.com/x", rank: null });
    // Merged into another producer's row: the gap's entry, not the merged top level.
    const merged = { citation_gap: { snapshotId: "s1" }, competitor: { brandUrl: "https://acme.com/blog/sso", brandRank: 12 } };
    expect(rankedPageOf({ source: "citation_gap", evidence: { brandUrl: "https://acme.com/stale", bySource: merged } })).toEqual({ url: "https://acme.com/blog/sso", rank: 12 });
    expect(rankedPageOf({ source: "citation_gap", evidence: { brandUrl: "https://acme.com/stale", bySource: { citation_gap: {}, competitor: { brandUrl: null } } } })).toBeNull();
    expect(rankedPageOf({ source: "citation_gap", evidence })).toBeNull();
    // The home page is no keyword's page; neither is a URL that does not parse.
    for (const brandUrl of ["https://acme.com/", "https://acme.com", "https://acme.com/?ref=x", "not a url"]) {
      expect(rankedPageOf({ source: "competitor", evidence: { brandUrl, brandRank: 15 } })).toBeNull();
    }
  });

  it("a page we can edit: refresh it instead of writing a second one", async () => {
    const sql = fakeSql([ranked({ content_item_id: null, cms_item_id: CMS, title: "SSO pricing explained", taken_down: null })]);
    expect(await checkCoverage(opp, sql)).toMatchObject({
      actionType: "refresh",
      hit: { kind: "keyword_rank", url: "https://acme.com/blog/sso-pricing", cmsItemId: CMS, contentItemId: null, measure: 14, surface: "organic", reason: "https://acme.com/blog/sso-pricing already ranks #14 for this keyword (DataForSEO Labs)" },
    });
    expect(sql.queries[1]!.values).toEqual(["https://acme.com/blog/sso-pricing", SITE_ID, SITE_ID]);
  });

  it("a page we cannot edit, or one taken down, is no hit: the estimate alone never makes a setup task", async () => {
    const product = fakeSql([ranked({ content_item_id: null, cms_item_id: null, title: null, taken_down: null })]);
    expect(await checkCoverage(opp, product)).toEqual({ actionType: "new_page", hit: null });
    const takenDown = fakeSql([ranked({ content_item_id: ITEM, cms_item_id: null, title: "SSO pricing", taken_down: "noindex" })]);
    expect(await checkCoverage(opp, takenDown)).toEqual({ actionType: "new_page", hit: null });
  });

  it("without the gap's evidence the check makes no query", async () => {
    for (const o of [{ ...opp, evidence: {} }, { ...opp, source: "citation_gap" as const }]) {
      const sql = fakeSql([]);
      await checkCoverage(o, sql);
      expect(sql.queries.some((q) => q.text.includes("content.url_key($1) as k"))).toBe(false);
    }
  });
});
