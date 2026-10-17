import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { TRACKING_PLAN_STATUSES, TRACKING_SITE_STATUSES } from "@/lib/demand/store";
import { normalizeDomain } from "@/lib/measure/source-roles";
import {
  belowTopicalFloor,
  demandOf,
  INTENT_WEIGHTS,
  loadQuestionDemand,
  loadTopicalContext,
  loadTopicWeights,
  opportunityKey,
  resolveIntent,
  scoreEV0,
  topicalFit,
  topicForTitle,
  topiclessValue,
  upsertOpportunities,
  type IntentSource,
  type OpportunityInput,
  type SearchIntent,
  type UpsertSummary,
} from "@/lib/pipeline/opportunities";
import { BudgetExceededError } from "@/lib/ops/spend";
import { monthOf, type ProviderIntent, type RankedKeyword } from "@/lib/serp/dataforseo-labs";
import { SerpProviderError, type SerpLocale } from "@/lib/serp/types";

/**
 * The competitor organic gap: the keywords a named competitor ranks for in
 * Google's organic top 10 and the site does not, from DataForSEO Labs
 * (lib/serp/dataforseo-labs.ts). Once a month and on demand, each named
 * competitor's domain (up to five) and the site's own are asked which
 * keywords they rank for; the difference becomes questions (source
 * competitor), the "Keywords they rank for that you don't" card, and the
 * best of it opportunities on the queue, scored with EV0 like every other
 * producer (gap type organic_competitor).
 *
 * A keyword the site ranks 11–20 for is in striking distance: the page that
 * ranks is the one to improve, and when it is one we can refresh the
 * coverage guard sends the work there rather than writing a second page
 * (lib/pipeline/coverage.ts; any other page, and the home page, leave the
 * work as it is). A keyword that names a competitor ("okta login", "okta
 * pricing") is its brand, not a topic, and is left out unless it compares
 * ("okta alternatives").
 *
 * Organic rankings only: nothing here is an AI answer, and none of it is
 * added to the AI Overview, probe or Profound numbers.
 */

/** A competitor counts when it ranks this high or higher. */
export const COMPETITOR_TOP_RANK = 10;
/** The site's own rankings are read down to here: 11 to this is striking distance. */
export const STRIKING_DISTANCE_MAX_RANK = 20;
/** Named competitor domains asked per run. */
export const MAX_GAP_COMPETITORS = 5;
/** Gap keywords kept per site (questions and card rows), best first. */
export const MAX_GAP_KEYWORDS = 500;
/** Opportunities opened per run, highest EV first. */
export const GAP_OPPORTUNITIES = 50;

// ── the plan ────────────────────────────────────────────────────────────────

/** One named competitor's domain to ask about. */
export interface GapTarget {
  domain: string;
  entityId: string;
  name: string;
}

export interface GapPlan {
  siteId: string;
  orgId: string;
  /** The site's own domain. */
  brand: string;
  market: SerpLocale;
  /** The market as measure.questions.locale spells it: "us-en". */
  locale: string;
  /** Up to MAX_GAP_COMPETITORS domains, the most cited competitors first. */
  competitors: GapTarget[];
  /** Every competitor's name, aliases and domain labels: a keyword naming one is that competitor's brand. */
  brandedTerms: string[];
  /** The month the rankings are cached under, fixed for the run. */
  month: string;
}

/** A site's locale ("en-US") as a market: country "us", language "en". */
export function marketOf(locale: string | null | undefined): SerpLocale {
  const [language = "en", country = "us"] = (locale || "en-US").split(/[-_]/).map((s) => s.trim().toLowerCase());
  return { country: country.slice(0, 2) || "us", language: language.slice(0, 2) || "en" };
}

/**
 * Languages written in the Latin alphabet. The gap keys a keyword the way
 * measure.questions does (normalizeQuestion keeps a–z and 0–9), so in any
 * other script every keyword keys to nothing, and a run would pay for
 * rankings it cannot read. Vietnamese is left out too: nearly every
 * syllable carries a mark the key drops.
 */
const LATIN_ALPHABET_LANGUAGES = new Set([
  "af", "az", "bs", "ca", "cs", "cy", "da", "de", "en", "es", "et", "eu", "fi", "fr", "ga", "gl", "hr", "hu", "id", "is",
  "it", "lt", "lv", "ms", "mt", "nb", "nl", "nn", "no", "pl", "pt", "ro", "sk", "sl", "sq", "sv", "sw", "tl", "tr", "uz",
]);

/** Whether the gap can read a market's keywords. Pure. */
export function gapMarketSupported(market: SerpLocale): boolean {
  return LATIN_ALPHABET_LANGUAGES.has(market.language.toLowerCase());
}

/** Second-level labels sold under a country code (`canva.com.au`, `bbc.co.uk`, `example.ne.jp`): the name is the label before. */
const SECOND_LEVEL_LABELS = new Set(["ac", "co", "com", "edu", "go", "gob", "gouv", "gov", "ltd", "mil", "ne", "net", "nom", "or", "org", "plc", "sch"]);

/** `okta.com` → `okta`, `login.auth0.com` → `auth0`, `canva.com.au` → `canva`: the name a domain is searched by. */
export function domainLabel(domain: string): string {
  const labels = domain.split(".");
  const tld = labels.length - 1;
  const name = labels.length >= 3 && labels[tld]!.length === 2 && SECOND_LEVEL_LABELS.has(labels[tld - 1]!) ? tld - 2 : tld - 1;
  return name >= 0 ? labels[name]! : domain;
}

interface CompetitorEntityRow {
  id: string;
  name: string;
  aliases: string[];
  domains: string[];
}

export type GapPlanResult = { plan: GapPlan } | { skipped: string };

/**
 * Who to ask about: the org's competitor entities with a domain, confirmed
 * ones first (a domain watched on a topic seeds an unconfirmed one), then
 * the most cited in the site's native AI Overviews over 90 days, then by
 * name; their domains in that order, the site's own left out, at most
 * MAX_GAP_COMPETITORS. A site that is paused or disabled, or whose plan
 * lapsed, spends nothing, as with every SERP job, and nor does one in a
 * market the gap cannot read (gapMarketSupported).
 */
export async function loadGapPlan(siteId: string, orgId: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<GapPlanResult> {
  const [site] = await sql<{ canonical_domain: string; locale: string; status: string; plan_status: string; org_id: string }[]>`
    select s.canonical_domain, s.locale, s.status::text as status, o.plan_status, s.org_id
    from app.sites s join app.organizations o on o.id = s.org_id
    where s.id = ${siteId}`;
  if (!site || site.org_id !== orgId) return { skipped: "site not found" };
  if (!(TRACKING_SITE_STATUSES as readonly string[]).includes(site.status)) return { skipped: `site is ${site.status}` };
  if (!(TRACKING_PLAN_STATUSES as readonly string[]).includes(site.plan_status)) return { skipped: `plan is ${site.plan_status}` };
  const market = marketOf(site.locale);
  if (!gapMarketSupported(market)) return { skipped: `market ${market.country}-${market.language}: keywords outside the Latin alphabet are not read` };
  const owned = new Set([normalizeDomain(site.canonical_domain), ...(await sql<{ hostname: string }[]>`select hostname from app.site_domains where site_id = ${siteId}`).map((d) => normalizeDomain(d.hostname))]);
  const entities = await sql<CompetitorEntityRow[]>`
    select e.id, e.name, e.aliases, e.domains
    from context.entities e
    where e.org_id = ${orgId} and e.type = 'competitor'
    order by cardinality(e.domains) = 0, (e.metadata ? 'seeded_from'),
             (select count(*) from measure.serp_citations c join measure.v_native_aio s on s.id = c.serp_snapshot_id
              where c.entity_id = e.id and c.site_id = ${siteId} and s.fetched_at >= now() - interval '90 days') desc,
             e.name, e.id`;
  const brandedTerms = new Set<string>();
  const competitors: GapTarget[] = [];
  for (const e of entities) {
    for (const term of [e.name, ...e.aliases, ...e.domains.map(domainLabel)]) {
      const t = normalizeQuestion(term);
      if (t.length >= 3) brandedTerms.add(t);
    }
    for (const d of e.domains) {
      const domain = normalizeDomain(d);
      if (!domain || owned.has(domain) || competitors.some((c) => c.domain === domain) || competitors.length >= MAX_GAP_COMPETITORS) continue;
      competitors.push({ domain, entityId: e.id, name: e.name });
    }
  }
  if (competitors.length === 0) return { skipped: "no named competitor with a domain" };
  return {
    plan: {
      siteId,
      orgId,
      brand: normalizeDomain(site.canonical_domain),
      market,
      locale: `${market.country}-${market.language}`,
      competitors,
      brandedTerms: [...brandedTerms],
      month: monthOf(now),
    },
  };
}

/** Sites the monthly run covers: tracked (not paused or disabled, plan not lapsed) in an org with a named competitor that has a domain. */
export async function sitesForCompetitorGap(sql: postgres.Sql = appDb()): Promise<{ site_id: string; org_id: string }[]> {
  return sql<{ site_id: string; org_id: string }[]>`
    select s.id as site_id, s.org_id
    from app.sites s
    join app.organizations o on o.id = s.org_id
    where s.status::text = any (${[...TRACKING_SITE_STATUSES]}::text[])
      and o.plan_status = any (${[...TRACKING_PLAN_STATUSES]}::text[])
      and exists (select 1 from context.entities e where e.org_id = s.org_id and e.type = 'competitor' and cardinality(e.domains) > 0)
    order by s.org_id, s.id`;
}

export const GAP_FETCH_RETRIES = 2;

/**
 * What the job does with a fetch that failed. A spent SERP budget stops the
 * run. A request DataForSEO refused (an HTTP 4xx, or a task status in the
 * 40000s: a market Labs does not cover, a target it rejects) goes the same
 * way again: skip it. Anything else (a timeout, a 5xx, a 50000s task status,
 * a database blip) is thrown for Inngest to retry the step, and skipped on
 * the last attempt. Pure.
 */
export function gapFetchFailure(error: unknown, attempt: number, retries = GAP_FETCH_RETRIES): "budget" | "retry" | "skip" {
  if (error instanceof BudgetExceededError) return "budget";
  const status = error instanceof SerpProviderError ? error.status : undefined;
  const refused = status !== undefined && ((status >= 400 && status < 500) || (status >= 40000 && status < 50000));
  if (refused || attempt >= retries) return "skip";
  return "retry";
}

// ── the gap ─────────────────────────────────────────────────────────────────

/** What one domain ranks for: its keywords, highest volume first, and whether the list was cut at the vendor's limit. */
export interface DomainKeywords {
  domain: string;
  truncated: boolean;
  keywords: RankedKeyword[];
}

export interface GapCompetitorRank {
  entityId: string;
  name: string;
  domain: string;
  rank: number;
  url: string | null;
}

export interface OrganicGapRow {
  keyword: string;
  normalized: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  searchIntent: ProviderIntent | null;
  intent: { value: SearchIntent; source: IntentSource };
  /** Where the site ranks (11–20), or null when not in the top 20. */
  brandRank: number | null;
  brandUrl: string | null;
  strikingDistance: boolean;
  /** Every named competitor in the top 10 for it, best rank first. */
  competitors: GapCompetitorRank[];
}

export interface OrganicGap {
  rows: OrganicGapRow[];
  /** Left out: the site already ranks in the top 10. */
  covered: number;
  /** Left out: the keyword names a competitor and does not compare. */
  branded: number;
  /**
   * Left out: the site's own list was cut at its limit above this keyword's
   * volume, so whether the site ranks for it is not known.
   */
  unknown: number;
}

/** Whole-word containment of any term in normalised text. */
export function namesAny(normalized: string, terms: string[]): boolean {
  const padded = ` ${normalized} `;
  return terms.some((t) => t.length >= 3 && padded.includes(` ${t} `));
}

/**
 * Keywords where some named competitor ranks in the top 10 and the site
 * ranks below it or not at all. Pure.
 *
 * The site's list is read to rank 20 (11–20 flags striking distance). When
 * it was cut at the vendor's limit, a keyword missing from it is a gap only
 * if its volume is above the lowest volume the list holds (the list is
 * ordered by volume, so anything above that would be in it); below that the
 * keyword is counted as unknown, not reported as a gap it may not be.
 * Commercial and transactional keywords sort first, then comparisons, then
 * informational, navigational last; within each, the highest volume.
 */
export function computeOrganicGap(
  brand: DomainKeywords,
  competitors: (DomainKeywords & GapTarget)[],
  opts: { brandedTerms?: string[]; topRank?: number; strikingMax?: number; limit?: number } = {},
): OrganicGap {
  const topRank = opts.topRank ?? COMPETITOR_TOP_RANK;
  const strikingMax = opts.strikingMax ?? STRIKING_DISTANCE_MAX_RANK;
  const terms = (opts.brandedTerms ?? []).map(normalizeQuestion);
  const own = new Map<string, RankedKeyword>();
  for (const k of brand.keywords) {
    const n = normalizeQuestion(k.keyword);
    const seen = own.get(n);
    if (n && (!seen || k.rank < seen.rank)) own.set(n, k);
  }
  const ownFloor = brand.truncated ? Math.min(...brand.keywords.map((k) => k.searchVolume ?? 0)) : null;

  const merged = new Map<string, OrganicGapRow>();
  for (const c of competitors) {
    for (const k of c.keywords) {
      if (k.rank > topRank) continue;
      const normalized = normalizeQuestion(k.keyword);
      if (normalized.length < 2) continue;
      const row = merged.get(normalized) ?? {
        keyword: k.keyword,
        normalized,
        searchVolume: k.searchVolume,
        keywordDifficulty: k.keywordDifficulty,
        searchIntent: k.searchIntent,
        intent: resolveIntent(k.keyword, k.searchIntent),
        brandRank: null,
        brandUrl: null,
        strikingDistance: false,
        competitors: [],
      };
      if (!row.competitors.some((r) => r.domain === c.domain)) row.competitors.push({ entityId: c.entityId, name: c.name, domain: c.domain, rank: k.rank, url: k.url });
      merged.set(normalized, row);
    }
  }

  let covered = 0;
  let branded = 0;
  let unknown = 0;
  const rows: OrganicGapRow[] = [];
  for (const row of merged.values()) {
    const mine = own.get(row.normalized);
    if (mine && mine.rank <= topRank) {
      covered++;
      continue;
    }
    if (!mine && ownFloor !== null && (row.searchVolume ?? 0) <= ownFloor) {
      unknown++;
      continue;
    }
    // "okta login" is Okta's; "okta alternatives" is a buyer comparing, and ours to answer.
    if (namesAny(row.normalized, terms) && resolveIntent(row.keyword, null).value !== "comparison") {
      branded++;
      continue;
    }
    if (mine && mine.rank <= strikingMax) {
      row.brandRank = mine.rank;
      row.brandUrl = mine.url;
      row.strikingDistance = true;
    }
    row.competitors.sort((a, b) => a.rank - b.rank || a.domain.localeCompare(b.domain));
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      INTENT_WEIGHTS[b.intent.value] - INTENT_WEIGHTS[a.intent.value] ||
      (b.searchVolume ?? -1) - (a.searchVolume ?? -1) ||
      a.competitors[0]!.rank - b.competitors[0]!.rank ||
      a.keyword.localeCompare(b.keyword),
  );
  return { rows: rows.slice(0, opts.limit ?? MAX_GAP_KEYWORDS), covered, branded, unknown };
}

// ── persistence ─────────────────────────────────────────────────────────────

export interface PersistGapInput {
  siteId: string;
  /** measure.questions.locale: "us-en". */
  locale: string;
  gap: OrganicGap;
  /** The competitor domains fetched this run: their earlier rows are replaced. */
  fetchedDomains: string[];
  /** The competitor domains the run covers; rows of any other domain (dropped, or no longer a competitor's) go. */
  plannedDomains: string[];
  fetchedAt: string;
}

export interface PersistGapSummary {
  questions: number;
  keywords: number;
  opportunities: UpsertSummary & { considered: number; belowFloor: number };
}

interface QuestionRow {
  id: string;
  normalized: string;
  excluded: boolean;
  topic_id: string | null;
}

/** Evidence an opportunity carries into its brief: the keyword's data, where we rank, who outranks us. */
export function gapEvidence(row: OrganicGapRow, ctx: { locale: string; fetchedAt: string }): Record<string, unknown> {
  return {
    kind: "organic_competitor",
    source: "dataforseo_labs",
    keyword: row.keyword,
    locale: ctx.locale,
    searchVolume: row.searchVolume,
    keywordDifficulty: row.keywordDifficulty,
    searchIntent: row.searchIntent,
    brandRank: row.brandRank,
    brandUrl: row.brandUrl,
    strikingDistance: row.strikingDistance,
    competitors: row.competitors.slice(0, 3).map(({ name, domain, rank, url }) => ({ name, domain, rank, url })),
    fetchedAt: ctx.fetchedAt,
  };
}

/**
 * Store one run's gap. The keywords become measure.questions rows (source
 * competitor, untracked; an existing question keeps its source, tracking,
 * exclusion and topic and takes the volume, difficulty and intent). A new
 * one's demand_score stays 0: that column is discovery's measure, and the
 * scorer reads the keyword's volume first. Picking by demand (the miner's
 * auto-track, "track the top N") passes over a competitor keyword at 0
 * (trackableByDemand in lib/demand/store.ts), so hundreds of keywords do
 * not turn into recurring SERP tracking nobody chose. The
 * card's rows replace those of every domain fetched this run (a domain
 * whose fetch failed keeps last month's), and the gap keywords above the
 * topical floor, not excluded, become opportunities: the GAP_OPPORTUNITIES
 * with the highest EV0, a new page each until the coverage guard says
 * otherwise. Work below the floor is not opened at all (the guard would
 * only dismiss it); a later run opens it once a topic or seed term ties it
 * to the site.
 */
export async function persistOrganicGap(input: PersistGapInput, sql: postgres.Sql = appDb()): Promise<PersistGapSummary> {
  const { siteId, locale, gap, fetchedAt } = input;
  const topics = await loadTopicWeights(siteId, sql);

  const questions = gap.rows.length
    ? await sql<QuestionRow[]>`
        insert into measure.questions as q (site_id, text, normalized, source, seed_term, depth, locale, device, search_volume, keyword_difficulty, search_intent, topic_id)
        select ${siteId}, r.text, r.normalized, 'competitor', r.seed_term, 1, ${locale}, 'desktop', r.search_volume, r.keyword_difficulty, r.search_intent, r.topic_id
        from jsonb_to_recordset(${sql.json(
          gap.rows.map((r) => ({
            text: r.keyword,
            normalized: r.normalized,
            seed_term: r.competitors[0]?.domain ?? null,
            search_volume: r.searchVolume,
            keyword_difficulty: r.keywordDifficulty,
            search_intent: r.searchIntent,
            topic_id: topicForTitle(r.keyword, topics)?.id ?? null,
          })) as never,
        )}) as r(text text, normalized text, seed_term text, search_volume int, keyword_difficulty smallint, search_intent text, topic_id uuid)
        on conflict (site_id, normalized, locale, device) do update set
          search_volume = coalesce(excluded.search_volume, q.search_volume),
          keyword_difficulty = coalesce(excluded.keyword_difficulty, q.keyword_difficulty),
          search_intent = coalesce(excluded.search_intent, q.search_intent),
          topic_id = coalesce(q.topic_id, excluded.topic_id),
          last_seen_at = now()
        returning q.id, q.normalized, q.excluded, q.topic_id`
    : [];
  const byNormalized = new Map(questions.map((q) => [q.normalized, q]));

  const keywordRows = gap.rows.flatMap((r) =>
    r.competitors.map((c) => ({
      entity_id: c.entityId,
      domain: c.domain,
      keyword: r.keyword,
      question_id: byNormalized.get(r.normalized)?.id ?? null,
      rank: c.rank,
      url: c.url,
      search_volume: r.searchVolume,
      keyword_difficulty: r.keywordDifficulty,
      search_intent: r.searchIntent,
      brand_rank: r.brandRank,
      brand_url: r.brandUrl,
    })),
  );
  const kept = keywordRows.filter((k) => input.fetchedDomains.includes(k.domain));
  const keywords = await sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    await tx`
      delete from measure.competitor_keywords
      where site_id = ${siteId} and (domain = any (${input.fetchedDomains}::text[]) or domain <> all (${input.plannedDomains}::text[]))`;
    if (kept.length === 0) return 0;
    // A competitor removed since the run was planned is skipped, not an error.
    const rows = await tx<{ id: string }[]>`
      insert into measure.competitor_keywords
        (site_id, entity_id, domain, keyword, question_id, rank, url, search_volume, keyword_difficulty, search_intent, brand_rank, brand_url, locale, fetched_at)
      select ${siteId}, r.entity_id, r.domain, r.keyword, r.question_id, r.rank, r.url, r.search_volume, r.keyword_difficulty, r.search_intent, r.brand_rank, r.brand_url, ${locale}, ${fetchedAt}
      from jsonb_to_recordset(${tx.json(kept as never)}) as r(entity_id uuid, domain text, keyword text, question_id uuid, rank smallint, url text,
                                                               search_volume int, keyword_difficulty smallint, search_intent text, brand_rank smallint, brand_url text)
      where exists (select 1 from context.entities e join app.sites s on s.org_id = e.org_id where e.id = r.entity_id and s.id = ${siteId} and e.type = 'competitor')
      on conflict (site_id, domain, keyword) do nothing
      returning id`;
    return rows.length;
  });

  const opportunities = await openGapOpportunities(siteId, gap.rows, byNormalized, topics, { locale, fetchedAt }, sql);
  return { questions: questions.length, keywords, opportunities };
}

async function openGapOpportunities(
  siteId: string,
  rows: OrganicGapRow[],
  questions: Map<string, QuestionRow>,
  topics: Awaited<ReturnType<typeof loadTopicWeights>>,
  ctx: { locale: string; fetchedAt: string },
  sql: postgres.Sql,
): Promise<PersistGapSummary["opportunities"]> {
  const candidates = rows.flatMap((r) => {
    const q = questions.get(r.normalized);
    return q && !q.excluded ? [{ row: r, question: q }] : [];
  });
  if (candidates.length === 0) return { inserted: 0, updated: 0, considered: 0, belowFloor: 0 };
  const [demand, fit] = await Promise.all([loadQuestionDemand(siteId, candidates.map((c) => c.question.id), sql), loadTopicalContext(siteId, sql, topics)]);
  const topicless = topiclessValue(topics);
  let belowFloor = 0;
  const scored: OpportunityInput[] = [];
  for (const { row, question } of candidates) {
    const q = demand.get(question.id);
    const topicId = question.topic_id ?? q?.topic_id ?? null;
    const topic = topicId ? topics.get(topicId) : undefined;
    if (topic && topic.status !== "active") continue;
    const brandFit = topicalFit(row.keyword, topicId, fit);
    if (belowTopicalFloor(brandFit)) {
      belowFloor++;
      continue;
    }
    const ev = scoreEV0({
      demand: demandOf(q),
      intent: resolveIntent(row.keyword, q?.search_intent ?? row.searchIntent),
      gapType: "organic_competitor",
      topic,
      topicless,
      brandFit,
      actionType: "new_page",
    });
    scored.push({
      source: "competitor",
      title: row.keyword,
      targetQuery: row.keyword,
      questionId: question.id,
      topicId,
      format: (topic?.formats[0] as OpportunityInput["format"]) ?? null,
      actionType: "new_page",
      score: ev.score,
      scoreBreakdown: ev.breakdown as unknown as Record<string, unknown>,
      evidence: gapEvidence(row, ctx),
      dedupeKey: opportunityKey(question),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const summary = await upsertOpportunities(siteId, scored.slice(0, GAP_OPPORTUNITIES), sql);
  return { ...summary, considered: candidates.length, belowFloor };
}

// ── read model ──────────────────────────────────────────────────────────────

export interface CompetitorGapRow {
  keyword: string;
  question_id: string | null;
  search_volume: number | null;
  keyword_difficulty: number | null;
  search_intent: ProviderIntent | null;
  brand_rank: number | null;
  brand_url: string | null;
  locale: string;
  /** The newest fetch behind the row. */
  fetched_at: string | Date;
  best_rank: number;
  /** Each with its own fetch: a domain whose last fetch failed shows the one before. */
  competitors: { name: string; domain: string; rank: number; url: string | null; fetched_at: string }[];
  /** The queue's work on the keyword's question, if any. */
  opportunity_status: string | null;
}

/**
 * A competitor's rows stay on the card while they are at most this much
 * older than the site's newest fetch: a domain whose fetch failed keeps its
 * rows through one missed monthly run (28–31 days), not two (59 or more).
 */
export const GAP_ROWS_KEPT_DAYS = 45;

/**
 * The card: gap keywords by keyword, every competitor that ranks for it
 * (only domains still a named competitor's), commercial and transactional
 * first, then by volume. Excluded questions are left out, and so are rows
 * more than GAP_ROWS_KEPT_DAYS older than the newest fetch. Where the site
 * ranks comes from the newest fetch of the keyword.
 */
export async function listCompetitorGap(siteId: string, opts: { topicId?: string | null; limit?: number } = {}, sql: postgres.Sql = appDb()): Promise<CompetitorGapRow[]> {
  return sql<CompetitorGapRow[]>`
    with kw as (
      select k.*, e.name
      from measure.competitor_keywords k
      join context.entities e on e.id = k.entity_id and e.type = 'competitor' and k.domain = any (e.domains)
      left join measure.questions q on q.id = k.question_id
      where k.site_id = ${siteId} and not coalesce(q.excluded, false)
        and (${opts.topicId ?? null}::uuid is null or q.topic_id = ${opts.topicId ?? null}::uuid)
        and k.fetched_at >= (select max(n.fetched_at) from measure.competitor_keywords n where n.site_id = ${siteId}) - make_interval(days => ${GAP_ROWS_KEPT_DAYS})
    ), grouped as (
      select keyword, (array_agg(question_id) filter (where question_id is not null))[1] as question_id,
             max(search_volume) as search_volume, max(keyword_difficulty) as keyword_difficulty, max(search_intent) as search_intent,
             (array_agg(brand_rank order by fetched_at desc, domain))[1] as brand_rank, (array_agg(brand_url order by fetched_at desc, domain))[1] as brand_url,
             min(locale) as locale, max(fetched_at) as fetched_at, min(rank) as best_rank,
             jsonb_agg(jsonb_build_object('name', name, 'domain', domain, 'rank', rank, 'url', url, 'fetched_at', fetched_at) order by rank, domain) as competitors
      from kw group by keyword
    )
    select g.*,
           (select o.status::text from content.opportunities o
            where o.site_id = ${siteId} and g.question_id is not null and o.dedupe_key = 'question:' || g.question_id::text limit 1) as opportunity_status
    from grouped g
    order by (g.search_intent in ('commercial', 'transactional')) desc nulls last, g.search_volume desc nulls last, g.best_rank, g.keyword
    limit ${opts.limit ?? 50}`;
}
