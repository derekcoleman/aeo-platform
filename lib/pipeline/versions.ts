import { appDb } from "@/lib/db/app";
import type postgres from "postgres";
import type { SourceVerification } from "./qa";
import type { BriefFact, Intent, ModelRun, QaGateResult, SourceSpec } from "./types";

/**
 * Content items + versions + the citation ledger + QA rows. Versions are
 * append-only: every draft attempt, approved or not, is a row, so the human
 * edit distance and the QA pass rate per prompt version are queries later.
 */

export interface ContentItemRow {
  id: string;
  org_id: string;
  site_id: string;
  slug: string;
  title: string | null;
  status: string;
  current_version_id: string | null;
}

/** Slug conflicts get a numeric suffix rather than failing the run; the check constraint bounds the shape. */
export async function reserveSlug(siteId: string, base: string, sql: postgres.Sql = appDb()): Promise<string> {
  const taken = await sql<{ slug: string }[]>`
    select slug from content.content_items where site_id = ${siteId} and (slug = ${base} or slug like ${`${base}-%`})`;
  const set = new Set(taken.map((t) => t.slug));
  if (!set.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 80 - String(n).length - 1)}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
  throw new Error(`could not find a free slug for ${base}`);
}

export async function createContentItem(
  input: { siteId: string; slug: string; title: string; briefId: string | null; authorId: string | null; opportunityId: string | null; type?: string },
  sql: postgres.Sql = appDb(),
): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into content.content_items (site_id, slug, type, status, title, brief_id, author_id, opportunity_id)
    values (${input.siteId}, ${input.slug}, ${input.type ?? "article"}, 'draft', ${input.title}, ${input.briefId}, ${input.authorId}, ${input.opportunityId})
    returning id`;
  if (!row) throw new Error("content item insert returned no row");
  return row;
}

export async function loadContentItem(id: string, sql: postgres.Sql = appDb()): Promise<ContentItemRow | null> {
  const [row] = await sql<ContentItemRow[]>`
    select id, org_id, site_id, slug, title, status, current_version_id from content.content_items where id = ${id}`;
  return row ?? null;
}

export interface VersionInput {
  contentItemId: string;
  title: string;
  description: string | null;
  /** Markdown with `{{src:key}}` markers intact — the source of truth. */
  bodyMd: string;
  /** Rendered, sanitised body HTML with markers resolved to links. */
  bodyHtml: string;
  frontmatter: { intent: Intent; faq: { question: string; answer: string }[]; briefId: string | null; attempt: number };
  schemaJsonLd: unknown | null;
  structureScore: unknown | null;
  wordCount: number;
  run: ModelRun;
  /** The manifesto this version was generated under, for reproducibility. */
  manifestVersionId?: string | null;
}

export interface VersionRow {
  id: string;
  org_id: string;
  content_item_id: string;
  version_no: number;
  title: string;
  description: string | null;
  body_md: string;
  body_html: string;
  frontmatter: VersionInput["frontmatter"];
  schema_jsonld: unknown | null;
  word_count: number;
}

export async function insertVersion(input: VersionInput, sql: postgres.Sql = appDb()): Promise<{ id: string; versionNo: number }> {
  const [row] = await sql<{ id: string; version_no: number }[]>`
    insert into content.content_versions
      (content_item_id, version_no, title, description, body_md, body_html, frontmatter, schema_jsonld, structure_score, word_count, model_run, manifest_version_id)
    values (
      ${input.contentItemId},
      (select coalesce(max(version_no), 0) + 1 from content.content_versions where content_item_id = ${input.contentItemId}),
      ${input.title}, ${input.description}, ${input.bodyMd}, ${input.bodyHtml},
      ${sql.json(input.frontmatter as never)}, ${input.schemaJsonLd == null ? null : sql.json(input.schemaJsonLd as never)},
      ${input.structureScore == null ? null : sql.json(input.structureScore as never)}, ${input.wordCount}, ${sql.json(input.run as never)},
      ${input.manifestVersionId ?? null})
    returning id, version_no`;
  if (!row) throw new Error("version insert returned no row");
  return { id: row.id, versionNo: row.version_no };
}

export async function loadVersion(id: string, sql: postgres.Sql = appDb()): Promise<VersionRow | null> {
  const [row] = await sql<VersionRow[]>`
    select id, org_id, content_item_id, version_no, title, description, body_md, body_html, frontmatter, schema_jsonld, word_count
    from content.content_versions where id = ${id}`;
  return row ?? null;
}

/** Ledger rows for every source the body actually cites, carrying the QA verification verdict. */
export async function insertSources(
  versionId: string,
  cited: SourceSpec[],
  verifications: SourceVerification[],
  sql: postgres.Sql = appDb(),
  now: Date = new Date(),
): Promise<number> {
  const byKey = new Map(verifications.map((v) => [v.key, v]));
  let n = 0;
  for (const s of cited) {
    const v = byKey.get(s.key);
    await sql`
      insert into content.content_sources (content_version_id, key, url, publisher, title, quote, accessed_at, verified, verified_at, verification)
      values (${versionId}, ${s.key}, ${s.url}, ${s.publisher ?? null}, ${s.title ?? null}, ${s.quote}, ${now},
              ${v?.verified ?? false}, ${v ? now : null}, ${v ? sql.json(v as never) : null})
      on conflict (content_version_id, key) do nothing`;
    n++;
  }
  return n;
}

export async function insertQaResults(versionId: string, gates: QaGateResult[], sql: postgres.Sql = appDb()): Promise<void> {
  for (const g of gates) {
    await sql`
      insert into content.qa_results (content_version_id, gate, passed, detail)
      values (${versionId}, ${g.gate}, ${g.passed}, ${sql.json(g.detail as never)})`;
  }
}

/** The fact half of the ledger: every `{{fact:key}}` the body cited, with the brand_facts id it resolved to. */
export async function insertContentFacts(versionId: string, facts: BriefFact[], sql: postgres.Sql = appDb()): Promise<number> {
  let n = 0;
  for (const f of facts) {
    await sql`
      insert into content.content_facts (content_version_id, key, fact_id, text)
      values (${versionId}, ${f.key}, ${f.factId}, ${f.text})
      on conflict (content_version_id, key) do nothing`;
    n++;
  }
  return n;
}

export async function loadContentFacts(versionId: string, sql: postgres.Sql = appDb()): Promise<{ key: string; fact_id: string | null; text: string }[]> {
  return sql<{ key: string; fact_id: string | null; text: string }[]>`select key, fact_id, text from content.content_facts where content_version_id = ${versionId} order by created_at, key`;
}

export async function loadSources(versionId: string, sql: postgres.Sql = appDb()): Promise<SourceSpec[]> {
  return sql<SourceSpec[]>`select key, url, publisher, title, quote from content.content_sources where content_version_id = ${versionId} order by accessed_at, key`;
}

export interface AuthorRow {
  id: string;
  name: string;
  job_title: string | null;
  url: string | null;
  same_as: string[];
}

/** The site's default author, else its first; a site with no author gets an organisation byline (handled by the caller). */
export async function defaultAuthor(siteId: string, sql: postgres.Sql = appDb()): Promise<AuthorRow | null> {
  const [row] = await sql<AuthorRow[]>`
    select id, name, job_title, url, same_as from content.authors
    where site_id = ${siteId} order by is_default desc, created_at limit 1`;
  return row ?? null;
}
