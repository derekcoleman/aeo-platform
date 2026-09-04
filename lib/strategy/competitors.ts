import type postgres from "postgres";
import { runPageRules, type StructureScore } from "@/lib/aeo/rules";
import { htmlToMarkdown, pageTitle, parseHtml, type Doc } from "@/lib/audit/html";
import { appDb } from "@/lib/db/app";
import { safeFetch } from "@/lib/fetch";

/**
 * Competitor content analysis. The pages currently cited for a topic are
 * fetched, scored with the same rule registry the audit and the pipeline
 * linter use, and classified by content type. The aggregate is the
 * structural target a brief must beat — the Res AI move applied before we
 * write, not after.
 */

export type ContentType = "comparison" | "howto" | "guide" | "listicle" | "faq" | "product" | "news" | "unknown";

export interface PageSignals {
  title: string;
  headings: string[];
  markdown: string;
  $: Doc;
}

const VS_RE = /\b(vs\.?|versus|compared?|comparison|alternatives?)\b/i;
const HOWTO_RE = /\b(how to|how do|step[- ]by[- ]step|tutorial|guide to)\b/i;
const LIST_RE = /\b(\d{1,3})\s+(best|top|ways|tools|tips|examples|reasons|ideas|strategies)\b/i;
const FAQ_RE = /\b(faq|frequently asked|questions?)\b/i;
const NEWS_RE = /\b(announce[sd]?|launch(es|ed)?|introduc(es|ing)|release notes|changelog|press release)\b/i;
const PRODUCT_RE = /\b(pricing|start free|free trial|book a demo|sign ?up|get started|buy now|add to cart)\b/gi;

export function classifyContentType(p: PageSignals): ContentType {
  const title = p.title;
  const heads = p.headings.join(" \n ");
  const hasTable = p.$("table").length > 0;
  const questionHeads = p.headings.filter((h) => /\?\s*$/.test(h) || /^(what|why|how|when|which|who|can|does|is|are)\b/i.test(h)).length;
  const orderedSteps = p.$("ol li").length >= 3 || p.headings.filter((h) => /^(step\s*)?\d+[.)]/i.test(h)).length >= 3;
  const ctaCount = (p.markdown.match(PRODUCT_RE) ?? []).length;
  if (VS_RE.test(title) || (hasTable && VS_RE.test(heads))) return "comparison";
  if (HOWTO_RE.test(title) || (orderedSteps && HOWTO_RE.test(heads))) return "howto";
  if (LIST_RE.test(title)) return "listicle";
  if (FAQ_RE.test(title) || (p.headings.length >= 4 && questionHeads / p.headings.length >= 0.7)) return "faq";
  if (NEWS_RE.test(title)) return "news";
  if (ctaCount >= 3 && p.markdown.length < 6000) return "product";
  if (p.markdown.length > 1500) return "guide";
  return "unknown";
}

export interface CompetitorPageAnalysis {
  url: string;
  domain: string;
  ok: boolean;
  status: number | null;
  title: string | null;
  contentType: ContentType;
  wordCount: number;
  headings: string[];
  structure: StructureScore | null;
  error: string | null;
}

export function analyzeHtml(url: string, html: string, headers?: Headers): Omit<CompetitorPageAnalysis, "ok" | "status" | "error"> {
  const $ = parseHtml(html);
  const markdown = htmlToMarkdown(html, 60_000);
  const headings = $("h2, h3").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 60);
  const title = pageTitle($) || null;
  const structure = runPageRules({ url, html, $, markdown, headers });
  return {
    url,
    domain: domainOf(url),
    title,
    contentType: classifyContentType({ title: title ?? "", headings, markdown, $ }),
    wordCount: markdown.split(/\s+/).filter(Boolean).length,
    headings,
    structure,
  };
}

export async function analyzeCompetitorPage(url: string, fetchImpl?: typeof fetch): Promise<CompetitorPageAnalysis> {
  try {
    const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024, maxRetries: 0, ...(fetchImpl ? { fetchImpl } : {}) });
    if (!res.ok) return { url, domain: domainOf(url), ok: false, status: res.status, title: null, contentType: "unknown", wordCount: 0, headings: [], structure: null, error: `status ${res.status}` };
    return { ...analyzeHtml(res.finalUrl || url, res.body, res.headers), url, ok: true, status: res.status, error: null };
  } catch (e) {
    return { url, domain: domainOf(url), ok: false, status: null, title: null, contentType: "unknown", wordCount: 0, headings: [], structure: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// ── which pages ─────────────────────────────────────────────────────────────

export interface CitedUrl {
  url: string;
  domain: string;
  citations: number;
  last_cited_at: string | Date;
  topic_id: string | null;
}

/** Non-owned AI Overview / answer citations in the window, grouped by URL, most cited first. */
export async function collectCompetitorUrls(siteId: string, opts: { topicId?: string | null; days?: number; limit?: number } = {}, sql: postgres.Sql = appDb()): Promise<CitedUrl[]> {
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 40;
  return sql<CitedUrl[]>`
    select c.url, c.domain, count(*)::int as citations, max(s.fetched_at) as last_cited_at,
           (array_agg(q.topic_id order by s.fetched_at desc) filter (where q.topic_id is not null))[1] as topic_id
    from measure.serp_citations c
    join measure.serp_snapshots s on s.id = c.serp_snapshot_id
    join measure.questions q on q.id = s.question_id
    where c.site_id = ${siteId} and not c.is_owned and c.surface = 'ai_overview'
      and s.fetched_at >= now() - make_interval(days => ${days})
      and not q.excluded
      and (${opts.topicId ?? null}::uuid is null or q.topic_id = ${opts.topicId ?? null}::uuid)
    group by c.url, c.domain
    order by citations desc, last_cited_at desc
    limit ${limit}`;
}

export async function upsertCompetitorPage(siteId: string, cited: CitedUrl, a: CompetitorPageAnalysis, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`
    insert into measure.competitor_pages (site_id, topic_id, url, domain, title, content_type, word_count, structure_score, headings, citations_30d, last_cited_at, fetch_status, fetch_error, fetched_at)
    values (${siteId}, ${cited.topic_id}, ${cited.url}, ${cited.domain}, ${a.title}, ${a.contentType}, ${a.wordCount}, ${a.structure ? sql.json(a.structure as never) : null},
            ${sql.json(a.headings as never)}, ${cited.citations}, ${cited.last_cited_at}, ${a.status}, ${a.error}, now())
    on conflict (site_id, url) do update set
      topic_id = coalesce(excluded.topic_id, measure.competitor_pages.topic_id),
      title = coalesce(excluded.title, measure.competitor_pages.title),
      content_type = case when excluded.fetch_error is null then excluded.content_type else measure.competitor_pages.content_type end,
      word_count = case when excluded.fetch_error is null then excluded.word_count else measure.competitor_pages.word_count end,
      structure_score = coalesce(excluded.structure_score, measure.competitor_pages.structure_score),
      headings = case when excluded.fetch_error is null then excluded.headings else measure.competitor_pages.headings end,
      citations_30d = excluded.citations_30d, last_cited_at = excluded.last_cited_at,
      fetch_status = excluded.fetch_status, fetch_error = excluded.fetch_error, fetched_at = now(), updated_at = now()`;
}

/** Refresh the cited-page set for a site (or one topic); pages fetched in the last 7 days keep their analysis and only update citation counts. */
export async function analyzeCompetitors(siteId: string, opts: { topicId?: string | null; limit?: number; fetchImpl?: typeof fetch } = {}, sql: postgres.Sql = appDb()): Promise<{ considered: number; fetched: number; failed: number }> {
  const cited = await collectCompetitorUrls(siteId, { topicId: opts.topicId, limit: opts.limit ?? 40 }, sql);
  const fresh = new Set(
    (await sql<{ url: string }[]>`select url from measure.competitor_pages where site_id = ${siteId} and fetched_at >= now() - interval '7 days' and fetch_error is null`).map((r) => r.url),
  );
  let fetched = 0;
  let failed = 0;
  for (const c of cited) {
    if (fresh.has(c.url)) {
      await sql`update measure.competitor_pages set citations_30d = ${c.citations}, last_cited_at = ${c.last_cited_at}, topic_id = coalesce(${c.topic_id}, topic_id), updated_at = now() where site_id = ${siteId} and url = ${c.url}`;
      continue;
    }
    const a = await analyzeCompetitorPage(c.url, opts.fetchImpl);
    await upsertCompetitorPage(siteId, c, a, sql);
    if (a.ok) fetched++;
    else failed++;
  }
  return { considered: cited.length, fetched, failed };
}

// ── read models ─────────────────────────────────────────────────────────────

export interface CompetitorPageRow {
  id: string;
  topic_id: string | null;
  url: string;
  domain: string;
  title: string | null;
  content_type: ContentType;
  word_count: number;
  structure_score: StructureScore | null;
  headings: string[];
  citations_30d: number;
  last_cited_at: string | Date | null;
  fetch_error: string | null;
  fetched_at: string | Date | null;
}

export async function listCompetitorPages(siteId: string, opts: { topicId?: string | null; limit?: number } = {}, sql: postgres.Sql = appDb()): Promise<CompetitorPageRow[]> {
  return sql<CompetitorPageRow[]>`
    select id, topic_id, url, domain, title, content_type, word_count, structure_score, headings, citations_30d, last_cited_at, fetch_error, fetched_at
    from measure.competitor_pages
    where site_id = ${siteId} and (${opts.topicId ?? null}::uuid is null or topic_id = ${opts.topicId ?? null}::uuid)
    order by citations_30d desc, last_cited_at desc nulls last limit ${opts.limit ?? 50}`;
}

export interface StructuralTarget {
  pages: number;
  dominantType: ContentType | null;
  typeShare: Record<string, number>;
  medianWords: number;
  tablePct: number;
  faqPct: number;
  questionHeadingPct: number;
  medianStructureScore: number | null;
  topPages: { url: string; domain: string; type: ContentType; words: number; citations: number }[];
}

function ruleShare(rows: CompetitorPageRow[], key: string): number {
  const with_ = rows.filter((r) => r.structure_score?.findings?.some((f) => f.key === key && f.passed));
  return rows.length ? Math.round((with_.length / rows.length) * 100) : 0;
}

/** What "currently cited" looks like for a topic: the bar a brief has to clear. */
export function structuralTargetFrom(rows: CompetitorPageRow[]): StructuralTarget {
  const analysed = rows.filter((r) => !r.fetch_error && r.word_count > 0).slice(0, 15);
  const typeCount: Record<string, number> = {};
  for (const r of analysed) typeCount[r.content_type] = (typeCount[r.content_type] ?? 0) + 1;
  const typeShare: Record<string, number> = {};
  for (const [k, v] of Object.entries(typeCount)) typeShare[k] = Math.round((v / Math.max(1, analysed.length)) * 100);
  const dominant = (Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0]?.[0] as ContentType | undefined) ?? null;
  const words = analysed.map((r) => r.word_count).sort((a, b) => a - b);
  const scores = analysed.map((r) => r.structure_score?.score).filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
  const qh = analysed.map((r) => {
    const hs = r.headings ?? [];
    return hs.length ? hs.filter((h) => /\?\s*$/.test(h) || /^(what|why|how|when|which|who|can|does|is|are)\b/i.test(h)).length / hs.length : 0;
  });
  return {
    pages: analysed.length,
    dominantType: dominant,
    typeShare,
    medianWords: median(words),
    tablePct: ruleShare(analysed, "comparison_table"),
    faqPct: ruleShare(analysed, "faq_block"),
    questionHeadingPct: qh.length ? Math.round((qh.reduce((a, b) => a + b, 0) / qh.length) * 100) : 0,
    medianStructureScore: scores.length ? median(scores) : null,
    topPages: analysed.slice(0, 8).map((r) => ({ url: r.url, domain: r.domain, type: r.content_type, words: r.word_count, citations: r.citations_30d })),
  };
}

export async function structuralTargetFor(siteId: string, topicId: string | null, sql: postgres.Sql = appDb()): Promise<StructuralTarget> {
  return structuralTargetFrom(await listCompetitorPages(siteId, { topicId, limit: 30 }, sql));
}

/** A prompt block for the brief writer. Short; the numbers are the point. */
export function structuralTargetBlock(t: StructuralTarget): string {
  if (t.pages === 0) return "";
  const lines = [
    `Pages currently cited for this topic (${t.pages} analysed): dominant format ${t.dominantType ?? "mixed"} (${Object.entries(t.typeShare).map(([k, v]) => `${k} ${v}%`).join(", ")}).`,
    `Median length ${t.medianWords} words; ${t.tablePct}% carry a comparison table; ${t.faqPct}% carry an FAQ block; ${t.questionHeadingPct}% of their headings are questions.`,
    `Beat them structurally: match the dominant format unless the brief says otherwise, exceed the median depth only where it adds a real answer, and include the table and FAQ when the intent calls for them.`,
    `Top cited pages:\n${t.topPages.map((p) => `- ${p.domain} (${p.type}, ${p.words} words, cited ${p.citations}×) ${p.url}`).join("\n")}`,
  ];
  return lines.join("\n");
}
