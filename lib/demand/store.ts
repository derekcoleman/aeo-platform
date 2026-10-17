import type postgres from "postgres";
import { vectorLiteral } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import { METHODOLOGY_VERSION } from "@/lib/app/methodology";
import { classifySource, loadSourceRoleContext, type SourceClassification, type SourceRoleContext } from "@/lib/measure/source-roles";
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
  const domains = [...new Set([site.canonical_domain, ...extra.map((d) => d.hostname)].map(stripWww))];
  return { siteId: site.id, orgId: site.org_id, domains, pathPrefix: site.path_prefix };
}

export function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * A citation's role for this site: owned when its URL is on the site (the
 * same test as is_owned), otherwise classifySource on its domain. `roles` is
 * read by the writer in the transaction that writes the row
 * (loadSourceRoleContext), never carried on SiteOwnership: serp-track
 * memoises its SiteOwnership for the whole run, and a competitor named or
 * removed meanwhile would be written with the role it had before (a removed
 * one's entity id failing the citation's foreign key).
 */
export function citationRole(url: string, domain: string, own: Pick<SiteOwnership, "domains">, roles: SourceRoleContext): SourceClassification {
  if (isOwnedUrl(url, own)) return { role: "owned", entityId: null };
  return classifySource(domain || safeHost(url), roles);
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
 * The questions picking by demand may start tracking ("track the top N", the
 * miner's auto-track), as a condition on measure.questions: not excluded, and
 * not a keyword only the competitor gap brought in (source competitor,
 * demand 0: lib/strategy/competitor-gap.ts). The gap stores up to 500 a
 * site; once the mined questions ran out, picking by demand would fill the
 * rest with them, a recurring SERP fetch each that nobody chose. One the
 * miner has found since carries its demand and qualifies.
 */
export function trackableByDemand(sql: postgres.Sql) {
  return sql`not excluded and (source <> 'competitor' or demand_score > 0)`;
}

/** The miner's auto-track: the `n` untracked questions with the most demand that may be tracked, onto the weekly tier. */
export async function autoTrackQuestions(siteId: string, n: number, sql: postgres.Sql = appDb()): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    with top as (
      select id from measure.questions
      where site_id = ${siteId} and not is_tracked and ${trackableByDemand(sql)}
      order by demand_score desc, seen_count desc
      limit ${n}
    )
    update measure.questions q set is_tracked = true, tracking_tier = 'weekly'
    from top where q.id = top.id returning q.id`;
  return rows.length;
}

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
 * surfaces. `is_owned`, `content_id` and the cited site's `source_role`
 * (with its competitor entity) are computed here — the snapshot is the
 * record of what Google showed, the citation rows are the join to us and to
 * the competitors. One transaction: a citation that cannot be written leaves
 * no snapshot behind to stand as the question's latest measurement. The
 * roles are read inside it, against the competitors and overrides as they
 * are now, not as the caller loaded `own`.
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
  type Row = { surface: "ai_overview" | "featured_snippet" | "organic" | "paa"; url: string; domain: string; position: number; title?: string; snippet?: string };
  const rows: Row[] = [];
  for (const r of aio?.references ?? []) rows.push({ surface: "ai_overview", url: r.url, domain: r.domain, position: r.position, title: r.title });
  if (result.featuredSnippet) rows.push({ surface: "featured_snippet", url: result.featuredSnippet.url, domain: result.featuredSnippet.domain, position: 1, title: result.featuredSnippet.title, snippet: result.featuredSnippet.snippet });
  for (const o of result.organic) rows.push({ surface: "organic", url: o.url, domain: o.domain, position: o.position, title: o.title, snippet: o.snippet });
  result.paa.forEach((p, i) => {
    if (p.sourceUrl) rows.push({ surface: "paa", url: p.sourceUrl, domain: stripWww(safeHost(p.sourceUrl)), position: i + 1, title: p.sourceTitle, snippet: p.answerSnippet });
  });

  return sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    const roles = await loadSourceRoleContext(own.siteId, own.orgId, tx, own.domains);
    const [snap] = await tx<{ id: string }[]>`
      insert into measure.serp_snapshots
        (site_id, question_id, provider, fetched_at, locale, device, aio_triggered, aio_text,
         featured_snippet_url, organic_count, cached, raw, cost_usd)
      values
        (${own.siteId}, ${questionId}, ${result.provider}, ${result.fetchedAt},
         ${`${result.locale.country}-${result.locale.language}`}, ${result.device},
         ${aio ? aio.triggered : null}, ${aio?.text ?? null}, ${result.featuredSnippet?.url ?? null},
         ${result.organic.length}, ${result.cached ?? false}, ${tx.json((result.raw ?? null) as never)}, ${result.costUsd})
      returning id`;
    const snapshotId = snap!.id;

    let owned = 0;
    for (const r of rows) {
      const isOwned = isOwnedUrl(r.url, own);
      const contentId = isOwned ? await contentIdForUrl(r.url, own, tx) : null;
      const source = citationRole(r.url, r.domain, own, roles);
      if (isOwned) owned += 1;
      await tx`
        insert into measure.serp_citations
          (site_id, serp_snapshot_id, surface, url, domain, position, is_owned, content_id, title, snippet, source_role, entity_id)
        values
          (${own.siteId}, ${snapshotId}, ${r.surface}, ${r.url}, ${r.domain}, ${r.position}, ${isOwned}, ${contentId},
           ${r.title ?? null}, ${r.snippet ?? null}, ${source.role}, ${source.entityId})`;
    }
    return { snapshotId, citations: rows.length, ownedCitations: owned, aioTriggered: aio ? aio.triggered : null };
  });
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
  /** Every non-owned domain the AI Overview cited. */
  competitor_domains: string[];
  /** The ones that are named competitors (source role competitor); forums, review sites and the rest are not. */
  named_competitor_domains: string[];
  /** How many named competitors those domains are: okta.com and blog.okta.com are one. */
  named_competitors: number;
}

/**
 * Our own SERP providers: the rows measure.v_native_aio holds (with
 * collection_method serp; a test checks the view names the same two).
 * Profound-sourced rows are enrichment and answer probes are their own
 * measurement; neither is in the view, so every native metric computes with
 * the connector off and the UI can attribute each number to its source.
 */
export const NATIVE_PROVIDERS = ["dataforseo", "serpapi"] as const;

/**
 * Where a read model's snapshots come from. `native`: Google results from our
 * own SERP trackers (measure.v_native_aio). `profound`: Profound's synced
 * answers from other engines and AI Mode, read on their own and labelled as
 * Profound's (measure.v_answer_observations, provider profound). Answer
 * probes have read models of their own (lib/app/visibility.ts).
 */
export type SnapshotSource = "native" | "profound";

/** The snapshot relation a read model joins for `source`, as a fragment to embed in its query. */
export function snapshotsFrom(source: SnapshotSource, sql: postgres.Sql) {
  return source === "profound" ? sql`(select * from measure.v_answer_observations where provider = 'profound')` : sql`measure.v_native_aio`;
}

/** A gap is judged on a snapshot at most this old; past it, the question needs measuring again before it is work. */
export const GAP_FRESHNESS_DAYS = 45;

/**
 * The highest-value opportunity type in the product: a question where an AI
 * Overview triggers, someone else is cited, and we are not. Judged on the
 * latest snapshot from our own trackers (measure.v_native_aio) per question
 * whatever it showed: when the newest one has no AI Overview, or cites us,
 * the gap is closed, not answered by an older snapshot that still had one.
 * Snapshots older than GAP_FRESHNESS_DAYS do not count.
 */
export async function citationGaps(siteId: string, limit = 50, sql: postgres.Sql = appDb()): Promise<CitationGap[]> {
  return sql<CitationGap[]>`
    with latest as (
      select distinct on (question_id) id, question_id, fetched_at, provider, aio_triggered
      from measure.v_native_aio
      where site_id = ${siteId} and fetched_at >= now() - make_interval(days => ${GAP_FRESHNESS_DAYS})
      order by question_id, fetched_at desc
    )
    select q.id as question_id, q.topic_id, q.text, q.demand_score::float as demand_score,
           l.id as snapshot_id, l.fetched_at, l.provider,
           array_agg(distinct c.domain order by c.domain) as competitor_domains,
           coalesce(array_agg(distinct c.domain order by c.domain) filter (where c.source_role = 'competitor'), '{}') as named_competitor_domains,
           (count(distinct coalesce(c.entity_id::text, c.domain)) filter (where c.source_role = 'competitor'))::int as named_competitors
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
  /** Named competitors only (source role competitor), by domain; forums, review sites and the like are not competitors. */
  top_competitors: { domain: string; citations: number }[];
  /** How these numbers are computed; see lib/app/methodology.ts. */
  methodology_version: string;
}

/** Share of AI Overview citations across the latest snapshot of every tracked question. */
export async function visibilitySummary(siteId: string, sql: postgres.Sql = appDb()): Promise<VisibilitySummary> {
  const [row] = await sql<{ questions_tracked: number; aio_triggered: number; aio_cited: number; featured_snippets_owned: number }[]>`
    with latest as (
      select distinct on (question_id) id, aio_triggered
      from measure.v_native_aio where site_id = ${siteId}
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
      select distinct on (question_id) id from measure.v_native_aio
      where site_id = ${siteId}
      order by question_id, fetched_at desc
    )
    select c.domain, count(*)::int as citations
    from measure.serp_citations c join latest on latest.id = c.serp_snapshot_id
    where c.surface = 'ai_overview' and c.source_role = 'competitor'
    group by c.domain order by citations desc limit 10`;
  return { ...row!, top_competitors: top, methodology_version: METHODOLOGY_VERSION };
}
