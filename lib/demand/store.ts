import type postgres from "postgres";
import { vectorLiteral } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import { METHODOLOGY_VERSION } from "@/lib/app/methodology";
import type { SerpProviderName, SerpResult } from "@/lib/serp";
import type { QuestionGraph } from "./question-graph";

/**
 * Persistence for the question graph and SERP snapshots. Everything here
 * runs on the service connection and scopes by site_id explicitly.
 */

export interface SiteOwnership {
  siteId: string;
  orgId: string;
  /** canonical_domain plus every honoured site_domains hostname, www-stripped. */
  domains: string[];
  pathPrefix: string;
}

export async function loadSiteOwnership(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteOwnership | null> {
  const [site] = await sql<{ id: string; org_id: string; canonical_domain: string; path_prefix: string }[]>`
    select id, org_id, canonical_domain, path_prefix from app.sites where id = ${siteId}`;
  if (!site) return null;
  const extra = await sql<{ hostname: string }[]>`select hostname from app.site_domains where site_id = ${siteId}`;
  const domains = [site.canonical_domain, ...extra.map((d) => d.hostname)].map(stripWww);
  return { siteId: site.id, orgId: site.org_id, domains: [...new Set(domains)], pathPrefix: site.path_prefix };
}

export function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function isOwnedUrl(url: string, own: Pick<SiteOwnership, "domains">): boolean {
  try {
    const host = stripWww(new URL(url).hostname);
    return own.domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Resolve a cited URL on the site's domain to the content item we published there, if any. */
export async function contentIdForUrl(url: string, own: SiteOwnership, sql: postgres.Sql = appDb()): Promise<string | null> {
  if (!isOwnedUrl(url, own)) return null;
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
  if (!path.startsWith(own.pathPrefix)) return null;
  const [row] = await sql<{ content_item_id: string | null }[]>`
    select content_item_id from content.published_pages
    where site_id = ${own.siteId} and (path = ${path} or path = ${path + "/"}) limit 1`;
  return row?.content_item_id ?? null;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  ids: Map<string, string>;
}

/** Cosine at or above this to a stored cluster's centroid (same embedding model) reuses that cluster. */
export const CLUSTER_REUSE_COSINE = 0.85;
/** The lexical fallback embedder: its centroids are bags of words, too crude to merge clusters across runs. */
const NON_MERGING_EMBEDDERS = new Set(["hash-bow"]);

/**
 * Persist one mined graph. `batchKey` names the unit of work (demand-mine
 * passes its run id): a question's sightings are added once per key, so a
 * step that is retried after it wrote does not count them twice, and a
 * cluster written under the key is found again instead of inserted again.
 * Clusters also merge across runs: a centroid within CLUSTER_REUSE_COSINE of
 * a stored one from the same embedding model joins it rather than starting a
 * near-duplicate.
 */
export async function upsertQuestionGraph(
  siteId: string,
  graph: QuestionGraph,
  opts: { locale: string; device: string; embeddingModel: string | null; batchKey?: string | null },
  sql: postgres.Sql = appDb(),
): Promise<UpsertResult> {
  const ids = new Map<string, string>();
  const batchKey = opts.batchKey ?? null;
  let inserted = 0;
  let updated = 0;

  // Clusters first so questions can reference them.
  const clusterIds: string[] = [];
  for (const c of graph.clusters) {
    const centroid = c.centroid ? vectorLiteral(c.centroid) : null;
    let id: string | null = null;
    if (batchKey) {
      const [again] = await sql<{ id: string }[]>`
        select id from measure.question_clusters where site_id = ${siteId} and updated_by_run = ${batchKey} and name = ${c.name} limit 1`;
      id = again?.id ?? null;
    }
    if (!id && centroid && opts.embeddingModel && !NON_MERGING_EMBEDDERS.has(opts.embeddingModel)) {
      const [near] = await sql<{ id: string }[]>`
        select id from measure.question_clusters
        where site_id = ${siteId} and embedding_model = ${opts.embeddingModel} and embedding is not null
          and embedding <=> ${centroid}::vector <= ${1 - CLUSTER_REUSE_COSINE}
        order by embedding <=> ${centroid}::vector limit 1`;
      id = near?.id ?? null;
    }
    if (!id) {
      const [row] = await sql<{ id: string }[]>`
        insert into measure.question_clusters (site_id, name, embedding, embedding_model, question_count, updated_by_run)
        values (${siteId}, ${c.name}, ${centroid}, ${opts.embeddingModel}, ${c.members.length}, ${batchKey})
        returning id`;
      id = row!.id;
    }
    clusterIds.push(id);
  }

  for (const q of graph.questions) {
    const clusterId = q.clusterIndex !== undefined ? (clusterIds[q.clusterIndex] ?? null) : null;
    const [row] = await sql<{ id: string; inserted: boolean }[]>`
      insert into measure.questions
        (site_id, text, normalized, source, seed_term, depth, locale, device, cluster_id,
         embedding, embedding_model, demand_score, paa_answer, seen_count, last_mine_batch)
      values
        (${siteId}, ${q.text}, ${q.normalized}, ${q.source}, ${q.seedTerm}, ${q.depth}, ${opts.locale}, ${opts.device},
         ${clusterId}, ${q.embedding ? vectorLiteral(q.embedding) : null}, ${q.embedding ? opts.embeddingModel : null},
         ${q.demandScore}, ${q.paaAnswer ? sql.json(q.paaAnswer as never) : null}, ${q.seenCount}, ${batchKey})
      on conflict (site_id, normalized, locale, device) do update set
        seen_count    = case when excluded.last_mine_batch is not null and measure.questions.last_mine_batch is not distinct from excluded.last_mine_batch
                             then measure.questions.seen_count
                             else measure.questions.seen_count + excluded.seen_count end,
        last_mine_batch = coalesce(excluded.last_mine_batch, measure.questions.last_mine_batch),
        demand_score  = greatest(measure.questions.demand_score, excluded.demand_score),
        depth         = least(measure.questions.depth, excluded.depth),
        source        = case when excluded.source = 'paa' then 'paa'::measure.question_source else measure.questions.source end,
        paa_answer    = coalesce(measure.questions.paa_answer, excluded.paa_answer),
        cluster_id    = coalesce(measure.questions.cluster_id, excluded.cluster_id),
        embedding     = coalesce(measure.questions.embedding, excluded.embedding),
        embedding_model = coalesce(measure.questions.embedding_model, excluded.embedding_model),
        last_seen_at  = now()
      returning id, (xmax = 0) as inserted`;
    ids.set(q.normalized, row!.id);
    if (row!.inserted) inserted += 1;
    else updated += 1;
  }

  // Parent links are by text; resolve after all ids exist.
  for (const q of graph.questions) {
    if (!q.parent) continue;
    const parentId = ids.get(q.parent.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim());
    const selfId = ids.get(q.normalized);
    if (parentId && selfId && parentId !== selfId) {
      await sql`update measure.questions set parent_question_id = ${parentId} where id = ${selfId} and parent_question_id is null`;
    }
  }

  // A reused cluster's count is whatever is attached to it now, not this batch's share.
  if (clusterIds.length) {
    await sql`
      update measure.question_clusters c
      set question_count = (select count(*)::int from measure.questions q where q.cluster_id = c.id),
          updated_by_run = coalesce(${batchKey}, c.updated_by_run), updated_at = now()
      where c.site_id = ${siteId} and c.id = any (${[...new Set(clusterIds)]}::uuid[])`;
  }
  return { inserted, updated, ids };
}

export { vectorLiteral };

export interface TrackedQuestion {
  id: string;
  site_id: string;
  org_id: string;
  text: string;
  locale: string;
  device: string;
  tracking_tier: "daily" | "weekly" | "monthly" | "none";
}

/** Plan states that still pay for tracking; anything else (canceled, paused) stops spending. */
export const TRACKING_PLAN_STATUSES = ["trialing", "active", "past_due"] as const;
/** Site states that are tracked; a paused or disabled site stops spending until it is resumed. */
export const TRACKING_SITE_STATUSES = ["provisioning", "verifying", "active"] as const;

/**
 * What a tier's scheduler snapshots: tracked questions that are not
 * excluded, on a site that is not paused or disabled, in an organisation
 * whose plan has not lapsed.
 */
export async function listTrackedQuestions(tier: TrackedQuestion["tracking_tier"], sql: postgres.Sql = appDb()): Promise<TrackedQuestion[]> {
  return sql<TrackedQuestion[]>`
    select q.id, q.site_id, q.org_id, q.text, q.locale, q.device, q.tracking_tier
    from measure.questions q
    join app.sites s on s.id = q.site_id
    join app.organizations o on o.id = s.org_id
    where q.is_tracked and q.tracking_tier = ${tier} and not q.excluded
      and s.status::text = any (${[...TRACKING_SITE_STATUSES]}::text[])
      and o.plan_status = any (${[...TRACKING_PLAN_STATUSES]}::text[])
    order by q.site_id, q.demand_score desc`;
}

/**
 * Persist one SERP fetch as a snapshot plus its citations, across all four
 * surfaces. `is_owned` and `content_id` are computed here — the snapshot is
 * the record of what Google showed, the citation rows are the join to us.
 */
/** A SERP result from our providers, or a Profound record shaped like one (provider 'profound'). */
export type SnapshotInput = Omit<SerpResult, "provider"> & { provider: SerpProviderName | "profound"; cached?: boolean };

export async function recordSnapshot(
  own: SiteOwnership,
  questionId: string,
  result: SnapshotInput,
  sql: postgres.Sql = appDb(),
): Promise<{ snapshotId: string; citations: number; ownedCitations: number; aioTriggered: boolean | null }> {
  const aio = result.aiOverview;
  const [snap] = await sql<{ id: string }[]>`
    insert into measure.serp_snapshots
      (site_id, question_id, provider, fetched_at, locale, device, aio_triggered, aio_text,
       featured_snippet_url, organic_count, cached, raw, cost_usd)
    values
      (${own.siteId}, ${questionId}, ${result.provider}, ${result.fetchedAt},
       ${`${result.locale.country}-${result.locale.language}`}, ${result.device},
       ${aio ? aio.triggered : null}, ${aio?.text ?? null}, ${result.featuredSnippet?.url ?? null},
       ${result.organic.length}, ${result.cached ?? false}, ${sql.json((result.raw ?? null) as never)}, ${result.costUsd})
    returning id`;
  const snapshotId = snap!.id;

  type Row = { surface: "ai_overview" | "featured_snippet" | "organic" | "paa"; url: string; domain: string; position: number; title?: string; snippet?: string };
  const rows: Row[] = [];
  for (const r of aio?.references ?? []) rows.push({ surface: "ai_overview", url: r.url, domain: r.domain, position: r.position, title: r.title });
  if (result.featuredSnippet) rows.push({ surface: "featured_snippet", url: result.featuredSnippet.url, domain: result.featuredSnippet.domain, position: 1, title: result.featuredSnippet.title, snippet: result.featuredSnippet.snippet });
  for (const o of result.organic) rows.push({ surface: "organic", url: o.url, domain: o.domain, position: o.position, title: o.title, snippet: o.snippet });
  result.paa.forEach((p, i) => {
    if (p.sourceUrl) rows.push({ surface: "paa", url: p.sourceUrl, domain: stripWww(safeHost(p.sourceUrl)), position: i + 1, title: p.sourceTitle, snippet: p.answerSnippet });
  });

  let owned = 0;
  for (const r of rows) {
    const isOwned = isOwnedUrl(r.url, own);
    const contentId = isOwned ? await contentIdForUrl(r.url, own, sql) : null;
    if (isOwned) owned += 1;
    await sql`
      insert into measure.serp_citations
        (site_id, serp_snapshot_id, surface, url, domain, position, is_owned, content_id, title, snippet)
      values
        (${own.siteId}, ${snapshotId}, ${r.surface}, ${r.url}, ${r.domain}, ${r.position}, ${isOwned}, ${contentId},
         ${r.title ?? null}, ${r.snippet ?? null})`;
  }
  return { snapshotId, citations: rows.length, ownedCitations: owned, aioTriggered: aio ? aio.triggered : null };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export interface CitationGap {
  question_id: string;
  topic_id: string | null;
  text: string;
  demand_score: number;
  snapshot_id: string;
  fetched_at: string;
  provider: string;
  competitor_domains: string[];
}

/**
 * Our own SERP providers. Profound-sourced rows are enrichment and are only
 * read when asked for explicitly, so every native metric computes with the
 * connector off and the UI can attribute each number to its source.
 */
export const NATIVE_PROVIDERS = ["dataforseo", "serpapi"] as const;
export type SnapshotProvider = SerpProviderName | "profound";

/** A gap is judged on a snapshot at most this old; past it, the question needs measuring again before it is work. */
export const GAP_FRESHNESS_DAYS = 45;

/**
 * The highest-value opportunity type in the product: a question where an AI
 * Overview triggers, someone else is cited, and we are not. Judged on the
 * latest snapshot per question whatever it showed: when the newest one has
 * no AI Overview, or cites us, the gap is closed, not answered by an older
 * snapshot that still had one. Snapshots older than GAP_FRESHNESS_DAYS do
 * not count.
 */
export async function citationGaps(
  siteId: string,
  limit = 50,
  sql: postgres.Sql = appDb(),
  providers: readonly SnapshotProvider[] = NATIVE_PROVIDERS,
): Promise<CitationGap[]> {
  return sql<CitationGap[]>`
    with latest as (
      select distinct on (question_id) id, question_id, fetched_at, provider, aio_triggered
      from measure.serp_snapshots
      where site_id = ${siteId} and provider = any (${[...providers]}::measure.serp_provider[])
        and fetched_at >= now() - make_interval(days => ${GAP_FRESHNESS_DAYS})
      order by question_id, fetched_at desc
    )
    select q.id as question_id, q.topic_id, q.text, q.demand_score::float as demand_score,
           l.id as snapshot_id, l.fetched_at, l.provider,
           array_agg(distinct c.domain order by c.domain) as competitor_domains
    from latest l
    join measure.questions q on q.id = l.question_id
    join measure.serp_citations c on c.serp_snapshot_id = l.id and c.surface = 'ai_overview'
    where l.aio_triggered is true and not q.excluded and not exists (
      select 1 from measure.serp_citations o
      where o.serp_snapshot_id = l.id and o.surface = 'ai_overview' and o.is_owned
    )
    group by q.id, q.topic_id, q.text, q.demand_score, l.id, l.fetched_at, l.provider
    order by q.demand_score desc
    limit ${limit}`;
}

export interface VisibilitySummary {
  questions_tracked: number;
  aio_triggered: number;
  aio_cited: number;
  featured_snippets_owned: number;
  top_competitors: { domain: string; citations: number }[];
  /** How these numbers are computed; see lib/app/methodology.ts. */
  methodology_version: string;
}

/** Share of AI Overview citations across the latest snapshot of every tracked question. */
export async function visibilitySummary(
  siteId: string,
  sql: postgres.Sql = appDb(),
  providers: readonly SnapshotProvider[] = NATIVE_PROVIDERS,
): Promise<VisibilitySummary> {
  const [row] = await sql<{ questions_tracked: number; aio_triggered: number; aio_cited: number; featured_snippets_owned: number }[]>`
    with latest as (
      select distinct on (question_id) id, aio_triggered
      from measure.serp_snapshots where site_id = ${siteId} and provider = any (${[...providers]}::measure.serp_provider[])
      order by question_id, fetched_at desc
    )
    select count(*)::int as questions_tracked,
           count(*) filter (where aio_triggered)::int as aio_triggered,
           count(*) filter (where exists (
             select 1 from measure.serp_citations c
             where c.serp_snapshot_id = latest.id and c.surface = 'ai_overview' and c.is_owned))::int as aio_cited,
           count(*) filter (where exists (
             select 1 from measure.serp_citations c
             where c.serp_snapshot_id = latest.id and c.surface = 'featured_snippet' and c.is_owned))::int as featured_snippets_owned
    from latest`;
  const top = await sql<{ domain: string; citations: number }[]>`
    with latest as (
      select distinct on (question_id) id from measure.serp_snapshots
      where site_id = ${siteId} and provider = any (${[...providers]}::measure.serp_provider[])
      order by question_id, fetched_at desc
    )
    select c.domain, count(*)::int as citations
    from measure.serp_citations c join latest on latest.id = c.serp_snapshot_id
    where c.surface = 'ai_overview' and not c.is_owned
    group by c.domain order by citations desc limit 10`;
  return { ...row!, top_competitors: top, methodology_version: METHODOLOGY_VERSION };
}
