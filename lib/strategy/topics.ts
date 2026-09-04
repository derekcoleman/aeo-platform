import type postgres from "postgres";
import { z } from "zod";
import { appDb } from "@/lib/db/app";
import { normalizeQuestion } from "@/lib/demand/question-graph";

/**
 * Topics: the customer's control surface over what gets tracked and written.
 * A topic carries priority (scoring weight), cadence (how many pieces a month
 * the queue may start), preferred formats, the seed terms that attach
 * questions to it, and the competitors to watch. Questions can be pinned
 * (always tracked, always eligible) or excluded (never scanned, never
 * briefed) without losing their history.
 */

export const TOPIC_FORMATS = ["comparison", "howto", "guide", "listicle", "faq"] as const;
export type TopicFormat = (typeof TOPIC_FORMATS)[number];

export interface TopicRow {
  id: string;
  org_id: string;
  site_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  priority: number;
  cadence_per_month: number;
  formats: TopicFormat[];
  seed_terms: string[];
  competitor_domains: string[];
  notes: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const list = z.preprocess((v) => (typeof v === "string" ? v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : v), z.array(z.string().min(1).max(120)).max(50));

export const topicInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(600).optional().default(""),
  priority: z.coerce.number().int().min(1).max(5).default(3),
  cadencePerMonth: z.coerce.number().int().min(0).max(30).default(2),
  formats: z.preprocess((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v : []), z.array(z.enum(TOPIC_FORMATS)).max(5)).default([]),
  seedTerms: list.default([]),
  competitorDomains: list.default([]),
  notes: z.string().trim().max(2000).optional().default(""),
  status: z.enum(["active", "paused", "archived"]).default("active"),
});
export type TopicInput = z.infer<typeof topicInputSchema>;

export function topicSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "topic";
}

const COLS = "id, org_id, site_id, name, slug, description, status, priority, cadence_per_month, formats, seed_terms, competitor_domains, notes, created_at, updated_at";

export async function listTopics(siteId: string, sql: postgres.Sql = appDb(), includeArchived = false): Promise<TopicRow[]> {
  return sql<TopicRow[]>`
    select id, org_id, site_id, name, slug, description, status, priority, cadence_per_month, formats, seed_terms, competitor_domains, notes, created_at, updated_at
    from measure.topics where site_id = ${siteId} and (${includeArchived}::boolean or status <> 'archived')
    order by priority desc, name`;
}

export async function loadTopic(siteId: string, topicId: string, sql: postgres.Sql = appDb()): Promise<TopicRow | null> {
  const [row] = await sql<TopicRow[]>`
    select id, org_id, site_id, name, slug, description, status, priority, cadence_per_month, formats, seed_terms, competitor_domains, notes, created_at, updated_at
    from measure.topics where site_id = ${siteId} and id = ${topicId}`;
  return row ?? null;
}

export async function createTopic(siteId: string, input: TopicInput, sql: postgres.Sql = appDb()): Promise<TopicRow> {
  const base = topicSlug(input.name);
  const taken = await sql<{ slug: string }[]>`select slug from measure.topics where site_id = ${siteId} and (slug = ${base} or slug like ${`${base}-%`})`;
  const set = new Set(taken.map((t) => t.slug));
  let slug = base;
  for (let i = 2; set.has(slug); i++) slug = `${base}-${i}`;
  const domains = input.competitorDomains.map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""));
  const [row] = await sql<TopicRow[]>`
    insert into measure.topics (site_id, name, slug, description, status, priority, cadence_per_month, formats, seed_terms, competitor_domains, notes)
    values (${siteId}, ${input.name}, ${slug}, ${input.description || null}, ${input.status}, ${input.priority}, ${input.cadencePerMonth},
            ${sql.array(input.formats)}::text[], ${sql.array(input.seedTerms)}::text[], ${sql.array(domains)}::text[], ${input.notes || null})
    returning id, org_id, site_id, name, slug, description, status, priority, cadence_per_month, formats, seed_terms, competitor_domains, notes, created_at, updated_at`;
  if (!row) throw new Error("topic insert returned no row");
  return row;
}

export async function updateTopic(siteId: string, topicId: string, input: TopicInput, sql: postgres.Sql = appDb()): Promise<TopicRow | null> {
  const domains = input.competitorDomains.map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""));
  const [row] = await sql<TopicRow[]>`
    update measure.topics set name = ${input.name}, description = ${input.description || null}, status = ${input.status}, priority = ${input.priority},
      cadence_per_month = ${input.cadencePerMonth}, formats = ${sql.array(input.formats)}::text[], seed_terms = ${sql.array(input.seedTerms)}::text[],
      competitor_domains = ${sql.array(domains)}::text[], notes = ${input.notes || null}, updated_at = now()
    where site_id = ${siteId} and id = ${topicId}
    returning id, org_id, site_id, name, slug, description, status, priority, cadence_per_month, formats, seed_terms, competitor_domains, notes, created_at, updated_at`;
  return row ?? null;
}

export { COLS as TOPIC_COLS };

// ── matching ────────────────────────────────────────────────────────────────

/** Whole-word containment on normalised text; the longest matching term wins, then the higher priority. */
export function matchTopic(text: string, topics: Pick<TopicRow, "id" | "name" | "seed_terms" | "priority" | "status">[]): { topicId: string; term: string } | null {
  const norm = ` ${normalizeQuestion(text)} `;
  let best: { topicId: string; term: string; len: number; priority: number } | null = null;
  for (const t of topics) {
    if (t.status === "archived") continue;
    for (const raw of [...t.seed_terms, t.name]) {
      const term = normalizeQuestion(raw);
      if (term.length < 3) continue;
      if (!norm.includes(` ${term} `)) continue;
      if (!best || term.length > best.len || (term.length === best.len && t.priority > best.priority)) best = { topicId: t.id, term: raw, len: term.length, priority: t.priority };
    }
  }
  return best ? { topicId: best.topicId, term: best.term } : null;
}

/** Attach unassigned questions (or all, when `reassign`) to the topic whose seed terms they contain. */
export async function assignQuestionsToTopics(siteId: string, opts: { reassign?: boolean } = {}, sql: postgres.Sql = appDb()): Promise<{ assigned: number; considered: number }> {
  const topics = await listTopics(siteId, sql);
  if (topics.length === 0) return { assigned: 0, considered: 0 };
  const questions = await sql<{ id: string; text: string; topic_id: string | null }[]>`
    select id, text, topic_id from measure.questions where site_id = ${siteId} and (${!!opts.reassign}::boolean or topic_id is null) limit 5000`;
  const ids: string[] = [];
  const topicIds: string[] = [];
  for (const q of questions) {
    const m = matchTopic(q.text, topics);
    if (m && m.topicId !== q.topic_id) {
      ids.push(q.id);
      topicIds.push(m.topicId);
    }
  }
  if (ids.length) {
    await sql`
      update measure.questions q set topic_id = m.topic_id
      from unnest(${sql.array(ids)}::uuid[], ${sql.array(topicIds)}::uuid[]) as m(id, topic_id)
      where q.id = m.id and q.site_id = ${siteId}`;
  }
  return { assigned: ids.length, considered: questions.length };
}

// ── prompt control ──────────────────────────────────────────────────────────

export type Tier = "daily" | "weekly" | "monthly" | "none";

/** A prompt or question added by hand: tracked immediately, pinned, attached to the topic. */
export async function addManualPrompt(siteId: string, input: { text: string; topicId?: string | null; tier?: Tier; locale?: string }, sql: postgres.Sql = appDb()): Promise<{ id: string; inserted: boolean }> {
  const text = input.text.trim();
  const tier = input.tier ?? "weekly";
  const [row] = await sql<{ id: string; inserted: boolean }[]>`
    insert into measure.questions (site_id, text, normalized, source, seed_term, depth, locale, device, demand_score, seen_count, is_tracked, tracking_tier, pinned, topic_id)
    values (${siteId}, ${text}, ${normalizeQuestion(text)}, 'manual', ${text}, 1, ${input.locale ?? "us-en"}, 'desktop', 50, 1, ${tier !== "none"}, ${tier}, true, ${input.topicId ?? null})
    on conflict (site_id, normalized, locale, device) do update
      set pinned = true, excluded = false, is_tracked = excluded.is_tracked, tracking_tier = excluded.tracking_tier,
          topic_id = coalesce(excluded.topic_id, measure.questions.topic_id), last_seen_at = now()
    returning id, (xmax = 0) as inserted`;
  if (!row) throw new Error("prompt insert returned no row");
  return row;
}

export async function setQuestionFlags(siteId: string, questionId: string, flags: { excluded?: boolean; pinned?: boolean; topicId?: string | null }, sql: postgres.Sql = appDb()): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update measure.questions set
      excluded = coalesce(${flags.excluded ?? null}::boolean, excluded),
      pinned = coalesce(${flags.pinned ?? null}::boolean, pinned),
      topic_id = case when ${flags.topicId === undefined}::boolean then topic_id else ${flags.topicId ?? null}::uuid end,
      is_tracked = case when ${flags.excluded === true}::boolean then false else is_tracked end
    where site_id = ${siteId} and id = ${questionId} returning id`;
  return rows.length > 0;
}

// ── stats ───────────────────────────────────────────────────────────────────

export interface TopicStats {
  topic_id: string;
  questions: number;
  tracked: number;
  aio_triggered: number;
  aio_cited: number;
  gaps: number;
  open_opportunities: number;
  published: number;
  published_30d: number;
  competitor_pages: number;
}

export async function topicStats(siteId: string, sql: postgres.Sql = appDb()): Promise<Map<string, TopicStats>> {
  const rows = await sql<TopicStats[]>`
    with latest as (
      select distinct on (s.question_id) s.question_id, s.id, s.aio_triggered
      from measure.serp_snapshots s where s.site_id = ${siteId} and s.provider in ('dataforseo', 'serpapi')
      order by s.question_id, s.fetched_at desc
    ), q as (
      select q.topic_id,
             count(*)::int as questions,
             count(*) filter (where q.is_tracked and not q.excluded)::int as tracked,
             count(*) filter (where l.aio_triggered)::int as aio_triggered,
             count(*) filter (where l.aio_triggered and exists (select 1 from measure.serp_citations c where c.serp_snapshot_id = l.id and c.surface = 'ai_overview' and c.is_owned))::int as aio_cited,
             count(*) filter (where l.aio_triggered and not exists (select 1 from measure.serp_citations c where c.serp_snapshot_id = l.id and c.surface = 'ai_overview' and c.is_owned)
                                and exists (select 1 from measure.serp_citations c where c.serp_snapshot_id = l.id and c.surface = 'ai_overview'))::int as gaps
      from measure.questions q left join latest l on l.question_id = q.id
      where q.site_id = ${siteId} and q.topic_id is not null
      group by q.topic_id
    )
    select t.id as topic_id,
           coalesce(q.questions, 0) as questions, coalesce(q.tracked, 0) as tracked, coalesce(q.aio_triggered, 0) as aio_triggered,
           coalesce(q.aio_cited, 0) as aio_cited, coalesce(q.gaps, 0) as gaps,
           (select count(*)::int from content.opportunities o where o.topic_id = t.id and o.status = 'open') as open_opportunities,
           (select count(*)::int from content.opportunities o join content.content_items ci on ci.id = o.content_item_id where o.topic_id = t.id and ci.status = 'published') as published,
           (select count(*)::int from content.opportunities o join content.content_items ci on ci.id = o.content_item_id where o.topic_id = t.id and ci.status = 'published' and ci.published_at >= now() - interval '30 days') as published_30d,
           (select count(*)::int from measure.competitor_pages p where p.topic_id = t.id) as competitor_pages
    from measure.topics t left join q on q.topic_id = t.id
    where t.site_id = ${siteId}`;
  return new Map(rows.map((r) => [r.topic_id, r]));
}

/** Pieces this topic may still start this month under its cadence. */
export function remainingCadence(topic: Pick<TopicRow, "cadence_per_month">, startedThisMonth: number): number {
  return Math.max(0, topic.cadence_per_month - startedThisMonth);
}
