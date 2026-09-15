import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { upsertOpportunities, type OpportunityInput, type UpsertSummary } from "@/lib/pipeline/opportunities";
import { candidateExclusion, REFRESH_MAX_OPPORTUNITIES, REFRESH_THRESHOLD, scoreRefresh, type RefreshScore, type RefreshSignals } from "./score";

/**
 * The refresh scan: join the CMS inventory with Search Console traffic and
 * AI citations, score every item, store the score on the row for the app,
 * and open a refresh opportunity for the top candidates so the pipeline can
 * pick them up like any other queue entry.
 */

export interface InventorySignalRow {
  id: string;
  site_id: string;
  title: string | null;
  url: string | null;
  collection_name: string;
  content_item_id: string | null;
  last_updated: Date | null;
  is_draft: boolean;
  is_archived: boolean;
  missing: boolean;
  has_body: boolean;
  word_count: number;
  heading_count: number;
  in_flight: boolean;
  clicks: number;
  clicks_prev: number;
  impressions: number;
  impressions_prev: number;
  position: number | null;
  cited_native: number;
  cited_native_prev: number;
  cited_profound: number;
  cited_profound_prev: number;
}

export interface SignalAvailability {
  gsc: boolean;
  native: boolean;
  profound: boolean;
}

export async function signalAvailability(siteId: string, sql: postgres.Sql = appDb()): Promise<SignalAvailability> {
  const [row] = await sql<SignalAvailability[]>`
    select exists (select 1 from measure.external_metrics where site_id = ${siteId} and surface = 'gsc_page_window') as gsc,
           exists (select 1 from measure.serp_snapshots where site_id = ${siteId} and provider in ('dataforseo', 'serpapi') and fetched_at >= now() - interval '60 days') as native,
           exists (select 1 from measure.serp_snapshots where site_id = ${siteId} and provider = 'profound' and fetched_at >= now() - interval '60 days') as profound`;
  return row ?? { gsc: false, native: false, profound: false };
}

/**
 * One row per inventory item with its signals. GSC rows are the latest
 * `gsc_page_window` per page and window; citations count distinct questions
 * in the last 30 days and the 30 before, split by provider family. Both join
 * on content.url_key so scheme, www and trailing slashes do not matter.
 */
export async function loadInventorySignals(siteId: string, sql: postgres.Sql = appDb(), opts: { itemId?: string | null } = {}): Promise<InventorySignalRow[]> {
  return sql<InventorySignalRow[]>`
    with gsc as (
      select distinct on (m.dimension->>'page', m.dimension->>'window')
        content.url_key(m.dimension->>'page') as key, m.dimension->>'window' as win,
        (m.metrics->>'clicks')::numeric as clicks, (m.metrics->>'impressions')::numeric as impressions, (m.metrics->>'position')::numeric as position
      from measure.external_metrics m
      where m.site_id = ${siteId} and m.provider = 'gsc' and m.surface = 'gsc_page_window'
      order by m.dimension->>'page', m.dimension->>'window', m.date desc
    ),
    gsc_by_key as (
      select key,
        sum(clicks) filter (where win = 'current') as clicks,
        sum(clicks) filter (where win = 'previous') as clicks_prev,
        sum(impressions) filter (where win = 'current') as impressions,
        sum(impressions) filter (where win = 'previous') as impressions_prev,
        avg(position) filter (where win = 'current') as position
      from gsc where key is not null group by key
    ),
    cites as (
      select content.url_key(c.url) as key,
        count(distinct s.question_id) filter (where s.provider <> 'profound' and s.fetched_at >= now() - interval '30 days') as native,
        count(distinct s.question_id) filter (where s.provider <> 'profound' and s.fetched_at < now() - interval '30 days') as native_prev,
        count(distinct s.question_id) filter (where s.provider = 'profound' and s.fetched_at >= now() - interval '30 days') as profound,
        count(distinct s.question_id) filter (where s.provider = 'profound' and s.fetched_at < now() - interval '30 days') as profound_prev
      from measure.serp_citations c join measure.serp_snapshots s on s.id = c.serp_snapshot_id
      where c.site_id = ${siteId} and c.is_owned and s.fetched_at >= now() - interval '60 days'
      group by 1
    )
    select i.id, i.site_id, i.title, i.url, i.collection_name, i.content_item_id, i.last_updated, i.is_draft, i.is_archived,
           (i.missing_since is not null) as missing, (i.body_html is not null) as has_body, i.word_count, i.heading_count,
           exists (select 1 from content.opportunities o where o.site_id = i.site_id and o.source = 'refresh' and o.evidence->>'cmsItemId' = i.id::text and o.status in ('queued', 'in_progress')) as in_flight,
           coalesce(g.clicks, 0)::float as clicks, coalesce(g.clicks_prev, 0)::float as clicks_prev,
           coalesce(g.impressions, 0)::float as impressions, coalesce(g.impressions_prev, 0)::float as impressions_prev,
           g.position::float as position,
           coalesce(c.native, 0)::int as cited_native, coalesce(c.native_prev, 0)::int as cited_native_prev,
           coalesce(c.profound, 0)::int as cited_profound, coalesce(c.profound_prev, 0)::int as cited_profound_prev
    from content.cms_items i
    left join gsc_by_key g on g.key = i.url_key
    left join cites c on c.key = i.url_key
    where i.site_id = ${siteId} ${opts.itemId ? sql`and i.id = ${opts.itemId}` : sql``}
    order by i.last_updated asc nulls first`;
}

export function ageDays(lastUpdated: Date | string | null, now: Date): number | null {
  if (!lastUpdated) return null;
  const t = new Date(lastUpdated).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function signalsFor(row: InventorySignalRow, avail: SignalAvailability, now: Date): RefreshSignals {
  return {
    ageDays: ageDays(row.last_updated, now),
    wordCount: row.word_count,
    headingCount: row.heading_count,
    gsc: { available: avail.gsc, clicks: row.clicks, clicksPrev: row.clicks_prev, impressions: row.impressions, impressionsPrev: row.impressions_prev, position: row.position },
    citations: {
      native: row.cited_native,
      nativePrev: row.cited_native_prev,
      profound: row.cited_profound,
      profoundPrev: row.cited_profound_prev,
      nativeAvailable: avail.native,
      profoundAvailable: avail.profound,
    },
  };
}

export interface ScoredItem {
  row: InventorySignalRow;
  signals: RefreshSignals;
  scored: RefreshScore;
  exclusion: string | null;
}

/** Score every inventory row; candidates are the non-excluded ones over the threshold, best first. */
export function scoreInventory(rows: InventorySignalRow[], avail: SignalAvailability, now: Date): { items: ScoredItem[]; candidates: ScoredItem[] } {
  const items = rows.map((row) => {
    const signals = signalsFor(row, avail, now);
    const exclusion = candidateExclusion({ isDraft: row.is_draft, isArchived: row.is_archived, missing: row.missing, hasBody: row.has_body, ageDays: signals.ageDays, inFlight: row.in_flight });
    return { row, signals, scored: scoreRefresh(signals), exclusion };
  });
  const candidates = items.filter((i) => !i.exclusion && i.scored.score >= REFRESH_THRESHOLD).sort((a, b) => b.scored.score - a.scored.score);
  return { items, candidates };
}

/**
 * The dedupe key carries the CMS modification date: once a refresh lands (or
 * the customer edits the post themselves) the key changes and the item can be
 * queued again later; a dismissed entry stays dismissed until then.
 */
export function refreshDedupeKey(cmsItemId: string, lastUpdated: Date | string | null): string {
  const stamp = lastUpdated ? new Date(lastUpdated).toISOString().slice(0, 10) : "unknown";
  return `cms:${cmsItemId}:${stamp}`;
}

export function refreshOpportunityFor(item: ScoredItem): OpportunityInput {
  const title = item.row.title ?? item.row.url ?? item.row.id;
  return {
    source: "refresh",
    title: `Refresh: ${title}`,
    targetQuery: title,
    contentItemId: item.row.content_item_id,
    score: item.scored.score,
    scoreBreakdown: item.scored.breakdown,
    evidence: {
      kind: "cms_refresh",
      cmsItemId: item.row.id,
      url: item.row.url,
      collection: item.row.collection_name,
      lastUpdated: item.row.last_updated ? new Date(item.row.last_updated).toISOString() : null,
      reasons: item.scored.reasons,
      signals: item.signals,
    },
    dedupeKey: refreshDedupeKey(item.row.id, item.row.last_updated),
  };
}

export interface RefreshScanSummary extends UpsertSummary {
  items: number;
  scored: number;
  candidates: number;
  availability: SignalAvailability;
}

export async function scanRefresh(siteId: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<RefreshScanSummary> {
  const [rows, avail] = await Promise.all([loadInventorySignals(siteId, sql), signalAvailability(siteId, sql)]);
  const { items, candidates } = scoreInventory(rows, avail, now);
  let scored = 0;
  for (const it of items) {
    await sql`
      update content.cms_items set
        refresh_score = ${it.scored.score}, refresh_breakdown = ${sql.json(it.scored.breakdown as never)},
        refresh_signals = ${sql.json({ ...it.signals, exclusion: it.exclusion } as never)},
        refresh_reasons = ${it.scored.reasons}::text[], scored_at = ${now}, updated_at = ${now}
      where id = ${it.row.id}`;
    scored++;
  }
  const summary = await upsertOpportunities(siteId, candidates.slice(0, REFRESH_MAX_OPPORTUNITIES).map(refreshOpportunityFor), sql);
  return { ...summary, items: rows.length, scored, candidates: candidates.length, availability: avail };
}

/**
 * "Refresh now" from the app: open (or find) the opportunity for one item at
 * its current score, whatever the threshold says. Returns the row the
 * caller queues; null when the item is unknown.
 */
export async function queueRefreshForItem(cmsItemId: string, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<{ id: string; status: string } | null> {
  const [ref] = await sql<{ site_id: string }[]>`select site_id from content.cms_items where id = ${cmsItemId}`;
  if (!ref) return null;
  const [row] = await loadInventorySignals(ref.site_id, sql, { itemId: cmsItemId });
  if (!row) return null;
  const avail = await signalAvailability(row.site_id, sql);
  const { items } = scoreInventory([row], avail, now);
  const item = items[0]!;
  const input = refreshOpportunityFor(item);
  await upsertOpportunities(row.site_id, [{ ...input, score: Math.max(input.score, REFRESH_THRESHOLD) }], sql);
  const [opp] = await sql<{ id: string; status: string }[]>`
    select id, status from content.opportunities where site_id = ${row.site_id} and dedupe_key = ${input.dedupeKey}`;
  if (!opp) return null;
  if (opp.status === "dismissed" || opp.status === "failed" || opp.status === "published") {
    await sql`update content.opportunities set status = 'open', score = ${Math.max(input.score, REFRESH_THRESHOLD)}, evidence = ${sql.json(input.evidence as never)}, updated_at = ${now} where id = ${opp.id}`;
    return { id: opp.id, status: "open" };
  }
  return opp;
}
