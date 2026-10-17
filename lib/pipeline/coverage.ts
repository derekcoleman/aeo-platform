import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { normalizeQuestion } from "@/lib/demand/question-graph";
import { ageDays, loadInventorySignals, scoreInventory, signalAvailability } from "@/lib/refresh/scan";
import { REFRESH_MIN_AGE_DAYS } from "@/lib/refresh/score";
import {
  belowTopicalFloor,
  dismissOpportunity,
  isManualOpportunity,
  loadTopicalContext,
  topicalFit,
  type ActionType,
  type BrandFit,
  type OpportunityRow,
} from "./opportunities";

/**
 * The coverage guard: one canonical URL per intent. Before the pipeline
 * writes a new page for an automated opportunity it asks whether the site
 * already answers the question:
 *
 *  1. the latest native SERP snapshot (measure.v_native_aio) has one of the
 *     site's pages in the organic top 10, or holds the featured snippet;
 *  1b. the competitor gap says which of the site's pages already ranks for
 *     the keyword (striking distance, 11–20 in DataForSEO Labs:
 *     lib/strategy/competitor-gap.ts), and it is a page we can refresh, so
 *     that page is the one to improve;
 *  2. a CMS post or one of our published articles has (nearly) the same
 *     title or slug (token Jaccard ≥ 0.8);
 *  3. a page of the site's own website crawl says the same thing (chunk
 *     cosine ≥ 0.85 against the question's embedding, same embedding model;
 *     never on the bag-of-words fallback, whose similarity is lexical).
 *
 * A hit on a page we can edit (one of our articles, or a CMS post with a
 * body) turns the work into a refresh of that page. A hit on anything else
 * (the home page ranks, a product page says it, or the article that says it
 * was taken down) is a setup task the pipeline cannot do, and the
 * opportunity is dismissed saying so; 1b only ever names a page we can edit,
 * so a vendor's ranking estimate alone never makes a setup task. Either way
 * no second URL competes with the first. A miss writes the new page.
 */

export const COVERAGE_TOP_N = 10;
export const COVERAGE_TITLE_JACCARD = 0.8;
export const COVERAGE_CHUNK_COSINE = 0.85;

export type CoverageKind = "serp_owned" | "keyword_rank" | "title_match" | "site_similarity";

export interface CoverageHit {
  kind: CoverageKind;
  url: string | null;
  title: string | null;
  /** One of our content items (a pipeline article, or a CMS post already imported). */
  contentItemId: string | null;
  /** A CMS post with a body, which a refresh imports and writes back in place. */
  cmsItemId: string | null;
  /** Rank (serp_owned, keyword_rank), token Jaccard (title_match) or cosine similarity (site_similarity). */
  measure: number;
  surface?: "organic" | "featured_snippet";
  /** The content item's page was taken down (noindex or retired): someone decided it should not be a live answer. */
  takenDown: "noindex" | "retired" | null;
  reason: string;
}

export interface CoverageVerdict {
  actionType: Extract<ActionType, "new_page" | "refresh" | "setup_task">;
  hit: CoverageHit | null;
}

// Words that carry no topic: question words, comparison connectors, title filler.
const STOP = new Set([
  "a", "an", "the", "of", "to", "for", "in", "on", "at", "by", "and", "or", "with", "without", "from", "about", "into", "is", "are", "be", "it", "its", "this", "that",
  "what", "whats", "how", "why", "when", "where", "which", "who", "does", "do", "can", "should", "i", "you", "your", "we", "our", "my",
  "vs", "versus", "between", "difference", "differences", "compared", "comparison",
  "guide", "complete", "ultimate", "definitive", "explained", "overview", "introduction", "everything", "need", "know",
]);

/** Topic tokens of a title, question or slug: normalised, stopwords out, a plural `s` folded. */
export function topicTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeQuestion(text.replace(/[-_/]+/g, " ")).split(" ")) {
    if (!raw || STOP.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function tokenJaccard(a: string, b: string): number {
  const x = topicTokens(a);
  const y = topicTokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

interface OwnedRow {
  url: string;
  title: string | null;
  position: number;
  surface: "organic" | "featured_snippet";
  content_item_id: string | null;
  cms_item_id: string | null;
  taken_down: CoverageHit["takenDown"];
}

const takenDownNote = (h: { takenDown: CoverageHit["takenDown"] }) => (h.takenDown ? `, and it was taken down (${h.takenDown})` : "");

/** 1. One of the site's pages ranks in the top 10 or holds the featured snippet in the latest native snapshot. */
export async function ownedSerpHit(siteId: string, questionId: string, sql: postgres.Sql = appDb()): Promise<CoverageHit | null> {
  const [row] = await sql<OwnedRow[]>`
    with latest as (
      select id from measure.v_native_aio
      where site_id = ${siteId} and question_id = ${questionId}
      order by fetched_at desc limit 1
    )
    select c.url, c.title, c.position, c.surface::text as surface,
           coalesce(c.content_id, ci.id) as content_item_id, i.id as cms_item_id, td.status as taken_down
    from latest l
    join measure.serp_citations c on c.serp_snapshot_id = l.id
    left join lateral (
      select id from content.content_items
      where site_id = ${siteId} and canonical_url is not null and content.url_key(canonical_url) = content.url_key(c.url) limit 1
    ) ci on true
    left join lateral (
      select id from content.cms_items
      where site_id = ${siteId} and url_key = content.url_key(c.url) and missing_since is null and not is_archived and body_html is not null limit 1
    ) i on true
    left join lateral (
      select p.status::text as status from content.published_pages p
      where p.content_item_id = coalesce(c.content_id, ci.id) and p.status <> 'live' limit 1
    ) td on true
    where c.is_owned and ((c.surface = 'organic' and c.position <= ${COVERAGE_TOP_N}) or c.surface = 'featured_snippet')
    order by ((coalesce(c.content_id, ci.id) is not null or i.id is not null) and td.status is null) desc, (c.surface = 'featured_snippet') desc, c.position
    limit 1`;
  if (!row) return null;
  const hit = { takenDown: row.taken_down ?? null };
  return {
    kind: "serp_owned",
    url: row.url,
    title: row.title,
    contentItemId: row.content_item_id,
    cmsItemId: row.content_item_id ? null : row.cms_item_id,
    measure: row.position,
    surface: row.surface,
    ...hit,
    reason: `${row.url} already ${row.surface === "featured_snippet" ? "holds the featured snippet" : `ranks #${row.position}`} for this question${takenDownNote(hit)}`,
  };
}

interface RankedPageRow {
  content_item_id: string | null;
  cms_item_id: string | null;
  title: string | null;
  taken_down: CoverageHit["takenDown"];
}

/** The site's page an opportunity says already ranks for its keyword, from keyword data rather than a snapshot. */
export interface RankedPage {
  url: string;
  rank: number | null;
}

/** A URL's path without its trailing slash: "" for a home page, null when it does not parse. */
function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * What the competitor gap's own evidence says ranks already (brandUrl and
 * brandRank): its entry under bySource when other producers' work on the
 * same question merged into the row, or the evidence itself on a row only
 * the gap opened. Never the merged top level, which carries whatever the
 * last producer wrote: the gap's organic estimate speaks for the gap's
 * entry, not for an AI Overview gap's. Null when it says nothing, or names
 * the home page, which ranks a little for most of what a site sells and is
 * no keyword's page to rewrite.
 */
export function rankedPageOf(opp: { source?: string | null; evidence?: Record<string, unknown> | null }): RankedPage | null {
  const bySource = opp.evidence?.bySource as Record<string, Record<string, unknown> | undefined> | undefined;
  const own = bySource && typeof bySource === "object" ? bySource.competitor : opp.source === "competitor" ? opp.evidence : null;
  const url = own?.brandUrl;
  if (typeof url !== "string" || !pathOf(url)) return null;
  const rank = own?.brandRank;
  return { url, rank: typeof rank === "number" && Number.isFinite(rank) ? rank : null };
}

/**
 * 1b. The page the competitor gap says ranks for the keyword, when it is one
 * we can refresh: one of our articles that is still live, or a CMS post with
 * a body. Anything else is no hit. A rank of 11–20 on a product page, a docs
 * page or an article someone took down does not say the site answers the
 * question, and an estimate alone must not turn the work into a setup task,
 * which stays dismissed whatever later months show; the other checks still
 * look (a page that does answer it is found by its title or its words).
 */
export async function rankedPageHit(siteId: string, page: RankedPage, sql: postgres.Sql = appDb()): Promise<CoverageHit | null> {
  const [row] = await sql<RankedPageRow[]>`
    select ci.id as content_item_id, i.id as cms_item_id, coalesce(ci.title, i.title) as title,
           (select p.status::text from content.published_pages p where p.content_item_id = ci.id and p.status <> 'live' limit 1) as taken_down
    from (select content.url_key(${page.url}) as k) u
    left join lateral (
      select id, title from content.content_items
      where site_id = ${siteId} and canonical_url is not null and content.url_key(canonical_url) = u.k limit 1
    ) ci on true
    left join lateral (
      select id, title from content.cms_items
      where site_id = ${siteId} and url_key = u.k and missing_since is null and not is_archived and body_html is not null limit 1
    ) i on true`;
  if (!row || row.taken_down || !(row.content_item_id || row.cms_item_id)) return null;
  return {
    kind: "keyword_rank",
    url: page.url,
    title: row.title,
    contentItemId: row.content_item_id,
    cmsItemId: row.content_item_id ? null : row.cms_item_id,
    measure: page.rank ?? 0,
    surface: "organic",
    takenDown: null,
    reason: `${page.url} already ranks${page.rank ? ` #${page.rank}` : ""} for this keyword (DataForSEO Labs)`,
  };
}

interface TitleRow {
  kind: "cms" | "own";
  id: string;
  title: string | null;
  slug: string | null;
  url: string | null;
  content_item_id: string | null;
  has_body: boolean;
  taken_down: CoverageHit["takenDown"];
}

/** 2. A CMS post or one of our published articles is titled (or slugged) the same way. */
export async function titleMatchHit(siteId: string, texts: string[], sql: postgres.Sql = appDb()): Promise<CoverageHit | null> {
  const rows = await sql<TitleRow[]>`
    select 'cms' as kind, i.id, i.title, i.slug, i.url, i.content_item_id, (i.body_html is not null) as has_body, null::text as taken_down
    from content.cms_items i
    where i.site_id = ${siteId} and i.missing_since is null and not i.is_archived and not i.is_draft
    union all
    select 'own' as kind, ci.id, ci.title, ci.slug, ci.canonical_url as url, ci.id as content_item_id, true as has_body,
           (select p.status::text from content.published_pages p where p.content_item_id = ci.id and p.status <> 'live' limit 1) as taken_down
    from content.content_items ci
    where ci.site_id = ${siteId} and ci.origin = 'pipeline' and ci.status = 'published'
    limit 5000`;
  // The closest title wins; at the same closeness, a page that is still live.
  let best: { row: TitleRow; score: number } | null = null;
  for (const row of rows) {
    for (const candidate of [row.title, row.slug]) {
      if (!candidate) continue;
      for (const text of texts) {
        const score = tokenJaccard(text, candidate);
        if (score >= COVERAGE_TITLE_JACCARD && (!best || score > best.score || (score === best.score && best.row.taken_down && !row.taken_down))) best = { row, score };
      }
    }
  }
  if (!best) return null;
  const { row, score } = best;
  const hit = { takenDown: row.taken_down ?? null };
  const rewritable = row.kind === "own" || !!row.content_item_id || row.has_body;
  return {
    kind: "title_match",
    url: row.url,
    title: row.title ?? row.slug,
    contentItemId: row.content_item_id,
    cmsItemId: row.kind === "cms" && !row.content_item_id && row.has_body ? row.id : null,
    measure: Math.round(score * 100) / 100,
    ...hit,
    reason: `"${row.title ?? row.slug}"${row.url ? ` (${row.url})` : ""} already covers this question${rewritable ? "" : ", and it has no body we can rewrite"}${takenDownNote(hit)}`,
  };
}

interface ChunkRow {
  url: string;
  title: string | null;
  similarity: number;
  content_item_id: string | null;
  cms_item_id: string | null;
  taken_down: CoverageHit["takenDown"];
}

/** 3. A page of the site's own website crawl says the same thing, by embedding. Skipped without a real embedding of the question. */
export async function siteSimilarityHit(siteId: string, questionId: string, sql: postgres.Sql = appDb()): Promise<CoverageHit | null> {
  const [q] = await sql<{ embedding_model: string | null }[]>`
    select embedding_model from measure.questions where id = ${questionId} and site_id = ${siteId} and embedding is not null`;
  // The bag-of-words fallback measures shared words, not meaning: 0.85 on it is not "the same answer".
  if (!q?.embedding_model || q.embedding_model === "hash-bow") return null;
  const [row] = await sql<ChunkRow[]>`
    with question as (select embedding, embedding_model from measure.questions where id = ${questionId} and site_id = ${siteId}),
    nearest as (
      select d.external_id as url, d.title, (1 - (ch.embedding <=> qn.embedding))::float as similarity
      from question qn
      join context.context_chunks ch on ch.embedding_model = qn.embedding_model and ch.embedding is not null
      join context.context_documents d on d.id = ch.document_id
      where d.provider = 'website' and d.site_id = ${siteId}
      order by ch.embedding <=> qn.embedding
      limit 1
    )
    select n.url, n.title, n.similarity, ci.id as content_item_id, i.id as cms_item_id,
           (select p.status::text from content.published_pages p where p.content_item_id = ci.id and p.status <> 'live' limit 1) as taken_down
    from nearest n
    left join lateral (
      select id from content.content_items
      where site_id = ${siteId} and canonical_url is not null and content.url_key(canonical_url) = content.url_key(n.url) limit 1
    ) ci on true
    left join lateral (
      select id from content.cms_items
      where site_id = ${siteId} and url_key = content.url_key(n.url) and missing_since is null and not is_archived and body_html is not null limit 1
    ) i on true`;
  if (!row || row.similarity < COVERAGE_CHUNK_COSINE) return null;
  const hit = { takenDown: row.taken_down ?? null };
  return {
    kind: "site_similarity",
    url: row.url,
    title: row.title,
    contentItemId: row.content_item_id,
    cmsItemId: row.content_item_id ? null : row.cms_item_id,
    measure: Math.round(row.similarity * 1000) / 1000,
    ...hit,
    reason: `${row.url} on the site already says this (similarity ${row.similarity.toFixed(2)})${takenDownNote(hit)}`,
  };
}

/** A page we can rewrite in place, and may: one taken down stays as someone left it. */
const editable = (h: CoverageHit) => !!(h.contentItemId || h.cmsItemId) && !h.takenDown;

/**
 * Does the site already answer this opportunity's question? The checks run
 * in order and stop at the first page we can refresh; a hit on a page we
 * cannot edit is kept in case no editable one turns up.
 */
export async function checkCoverage(
  opp: Pick<OpportunityRow, "site_id" | "question_id" | "title" | "target_query"> & { source?: OpportunityRow["source"]; evidence?: Record<string, unknown> | null },
  sql: postgres.Sql = appDb(),
): Promise<CoverageVerdict> {
  let fallback: CoverageHit | null = null;
  const ranked = rankedPageOf(opp);
  const checks: (() => Promise<CoverageHit | null>)[] = [
    () => (opp.question_id ? ownedSerpHit(opp.site_id, opp.question_id, sql) : Promise.resolve(null)),
    () => (ranked ? rankedPageHit(opp.site_id, ranked, sql) : Promise.resolve(null)),
    () => titleMatchHit(opp.site_id, [...new Set([opp.title, opp.target_query])], sql),
    () => (opp.question_id ? siteSimilarityHit(opp.site_id, opp.question_id, sql) : Promise.resolve(null)),
  ];
  for (const check of checks) {
    const hit = await check();
    if (!hit) continue;
    if (editable(hit)) return { actionType: "refresh", hit };
    fallback ??= hit;
  }
  return fallback ? { actionType: "setup_task", hit: fallback } : { actionType: "new_page", hit: null };
}

/**
 * What the refresh lifecycle says about rewriting a page now: whether other
 * work on it is already queued or running (whatever produced it: the
 * refresh scan, the post-publish loop, another question the guard sent to
 * the same page), how long since it last changed, and whether it is a
 * protected winner (lib/refresh/score.ts isProtectedWinner, judged against
 * the whole inventory as the refresh scan judges it).
 */
export interface PageLifecycle {
  /** The page as a CMS post, when it is one (imported or not). */
  cmsItemId: string | null;
  /** The page as one of our content items, when it is one. */
  contentItemId: string | null;
  /** Days since the page last changed: the CMS's modification date, or our last publish. Null when unknown. */
  ageDays: number | null;
  protectedWinner: boolean;
}

export async function pageLifecycle(siteId: string, hit: Pick<CoverageHit, "contentItemId" | "cmsItemId">, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<PageLifecycle> {
  const [page] = await sql<{ cms_item_id: string | null; content_item_id: string | null; published_at: Date | null }[]>`
    select i.id as cms_item_id, coalesce(${hit.contentItemId}::uuid, i.content_item_id) as content_item_id, ci.published_at
    from (select 1) one
    left join content.cms_items i on i.site_id = ${siteId} and (i.id = ${hit.cmsItemId}::uuid or i.content_item_id = ${hit.contentItemId}::uuid)
    left join content.content_items ci on ci.id = coalesce(${hit.contentItemId}::uuid, i.content_item_id)
    limit 1`;
  const cmsItemId = page?.cms_item_id ?? hit.cmsItemId;
  const contentItemId = page?.content_item_id ?? hit.contentItemId;
  if (!cmsItemId) return { cmsItemId: null, contentItemId, ageDays: ageDays(page?.published_at ?? null, now), protectedWinner: false };
  const [rows, avail] = await Promise.all([loadInventorySignals(siteId, sql), signalAvailability(siteId, sql)]);
  const item = scoreInventory(rows, avail, now).items.find((i) => i.row.id === cmsItemId);
  return { cmsItemId, contentItemId, ageDays: item?.signals.ageDays ?? null, protectedWinner: item?.protectedWinner ?? false };
}

export type GuardOutcome =
  | { proceed: true; actionType: ActionType; contentItemId: string | null; evidence: Record<string, unknown>; brandFit: BrandFit | null; checked: boolean }
  | { proceed: false; dismissReason: "auto_coverage" | "auto_topical_floor"; reason: string };

/**
 * The guard step before the brief, for automated new-page work only (a
 * person's request, a refresh and anything already briefed pass as they
 * are; the last covers runs that started before the guard existed).
 *
 * First the topical floor: work nothing ties to the site's topics, seeds or
 * brand is dismissed (auto_topical_floor). Then coverage: a refresh hit
 * rewrites the opportunity into a refresh of that page, and the run goes on
 * from what this returns, not from the opportunity it loaded earlier; a
 * setup task is dismissed (auto_coverage). A refresh hit follows the refresh
 * lifecycle first: a page changed in the last REFRESH_MIN_AGE_DAYS, or with
 * other work already queued or running on it, is not rewritten again (the
 * work is dismissed, auto_coverage); a protected winner gets a figures-and-
 * dates update, never a rewrite. Every dismissal says how to ask for the page
 * anyway. The floor and the refresh lifecycle's waits pass: a scan reopens
 * such work once its question clears the floor or the wait is over
 * (upsertOpportunities); a setup task stays dismissed.
 */
export type GuardedOpportunity = Pick<OpportunityRow, "id" | "site_id" | "source" | "title" | "target_query" | "question_id" | "topic_id" | "content_item_id" | "evidence"> & {
  /** Absent on an opportunity loaded by a run from before the column (memoised): read from its source. */
  action_type?: ActionType | null;
};

const ANYWAY = "or use “Write about this” to have a new page written anyway.";
// Dismissals that pass with time come back to the queue at a scan (upsertOpportunities), and the guard looks again.
const BACK_LATER = `The scan brings it back in ${REFRESH_MIN_AGE_DAYS} days to look again`;

export async function coverageGuard(opp: GuardedOpportunity, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<GuardOutcome> {
  const actionType = opp.action_type ?? (opp.source === "refresh" ? "refresh" : "new_page");
  const unchanged = { proceed: true as const, actionType, contentItemId: opp.content_item_id, evidence: opp.evidence, brandFit: null, checked: false };
  if (actionType !== "new_page" || opp.source === "refresh" || isManualOpportunity(opp) || opp.content_item_id || typeof opp.evidence.cmsItemId === "string") return unchanged;
  const [briefed] = await sql<{ id: string }[]>`select id from content.briefs where opportunity_id = ${opp.id} limit 1`;
  if (briefed) return unchanged;

  const fit = topicalFit(`${opp.title} ${opp.target_query}`, opp.topic_id, await loadTopicalContext(opp.site_id, sql));
  if (belowTopicalFloor(fit)) {
    const reason = `Not written: ${fit.reason}. Add it to one of the site's topics and the next scan brings it back, ${ANYWAY}`;
    await dismissOpportunity(opp.id, "auto_topical_floor", reason, sql);
    return { proceed: false, dismissReason: "auto_topical_floor", reason };
  }

  const coverageDismissal = async (reason: string, tx: postgres.Sql = sql, opts: { actionType?: ActionType } = {}): Promise<GuardOutcome> => {
    await dismissOpportunity(opp.id, "auto_coverage", reason, tx, opts);
    return { proceed: false, dismissReason: "auto_coverage", reason };
  };

  const verdict = await checkCoverage(opp, sql);
  if (verdict.actionType === "setup_task" && verdict.hit) {
    const hit = verdict.hit;
    const next = hit.takenDown ? "Restore that page" : "Improve that page rather than adding a second one";
    return coverageDismissal(`Not written: ${hit.reason}. ${next}, ${ANYWAY}`, sql, { actionType: "setup_task" });
  }
  if (verdict.actionType === "refresh" && verdict.hit) {
    const hit = verdict.hit;
    const life = await pageLifecycle(opp.site_id, hit, sql, now);
    if (life.ageDays !== null && life.ageDays < REFRESH_MIN_AGE_DAYS) {
      return coverageDismissal(
        `Not written: ${hit.reason}, and it changed ${life.ageDays} days ago, too recently to rewrite (a page waits ${REFRESH_MIN_AGE_DAYS} days, so the engines see a version before the next). ${BACK_LATER}, ${ANYWAY}`,
      );
    }
    // Claiming the page and checking nobody else has are one step: two runs
    // sent to the same page at once take turns here, and the second sees the first.
    return sql.begin(async (trx) => {
      const tx = trx as unknown as postgres.Sql;
      await tx`select pg_advisory_xact_lock(hashtext(${`coverage:${life.cmsItemId ?? life.contentItemId}`}))`;
      const [busy] = await tx<{ id: string; title: string }[]>`
        select id, title from content.opportunities
        where site_id = ${opp.site_id} and id <> ${opp.id} and status in ('queued', 'in_progress')
          and (content_item_id = ${life.contentItemId}::uuid or evidence->>'cmsItemId' = ${life.cmsItemId}::text)
        limit 1`;
      if (busy) return coverageDismissal(`Not written: ${hit.reason}, and work on that page is already queued or running (“${busy.title}”): one rewrite at a time. ${BACK_LATER}, ${ANYWAY}`, tx);
      // A winner is not rewritten for another question; its figures and dates may be brought up to date.
      const action: ActionType = life.protectedWinner ? "update_stats" : "refresh";
      const coverage = { kind: hit.kind, url: hit.url, title: hit.title, measure: hit.measure, surface: hit.surface ?? null, reason: hit.reason };
      const why = life.protectedWinner ? "it is cited and holding its traffic, so this updates its figures and dates only" : "one page per question, so this refreshes it";
      const added: Record<string, unknown> = { coverage, reasons: [`${hit.reason}: ${why}`], ...(life.protectedWinner ? { protectedWinner: true } : {}) };
      if (hit.cmsItemId) added.cmsItemId = hit.cmsItemId;
      await tx`
        update content.opportunities
        set action_type = ${action}::content.action_type, content_item_id = coalesce(${hit.contentItemId}, content_item_id),
            evidence = evidence || ${tx.json(added as never)}, updated_at = now()
        where id = ${opp.id}`;
      return { proceed: true as const, actionType: action, contentItemId: hit.contentItemId ?? opp.content_item_id, evidence: { ...opp.evidence, ...added }, brandFit: fit, checked: true };
    });
  }
  return { ...unchanged, brandFit: fit, checked: true };
}
