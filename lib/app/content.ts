import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { ApprovalRow } from "@/lib/pipeline/approvals";
import type { BriefSpec } from "@/lib/pipeline/types";

/**
 * Read models for the content pages: the list of items with their latest
 * version and QA state, and everything an approval review needs on one screen
 * (brief or version, provenance, gates).
 */

export interface ContentListRow {
  id: string;
  slug: string;
  title: string | null;
  status: string;
  current_version_id: string | null;
  version_no: number | null;
  word_count: number | null;
  published_path: string | null;
  published_at: string | Date | null;
  pending_approval_id: string | null;
  pending_kind: "brief" | "draft" | null;
  qa_failed: number;
  updated_at: string | Date;
}

export async function listContentItems(siteId: string, limit = 50, sql: postgres.Sql = appDb()): Promise<ContentListRow[]> {
  return sql<ContentListRow[]>`
    select ci.id, ci.slug, ci.title, ci.status, ci.current_version_id,
           v.version_no, v.word_count,
           p.path as published_path, p.updated_at as published_at,
           a.id as pending_approval_id, a.kind as pending_kind,
           coalesce((select count(*)::int from content.qa_results q where q.content_version_id = ci.current_version_id and not q.passed), 0) as qa_failed,
           greatest(ci.updated_at, coalesce(v.created_at, ci.updated_at)) as updated_at
    from content.content_items ci
    left join content.content_versions v on v.id = ci.current_version_id
    left join content.published_pages p on p.content_item_id = ci.id and p.site_id = ci.site_id
    left join lateral (
      select id, kind from content.approvals ap
      where ap.site_id = ci.site_id and ap.status = 'pending'
        and (ap.content_version_id = ci.current_version_id or ap.brief_id = ci.brief_id)
      order by ap.requested_at desc limit 1
    ) a on true
    where ci.site_id = ${siteId}
    order by greatest(ci.updated_at, coalesce(v.created_at, ci.updated_at)) desc limit ${limit}`;
}

export interface QaResultRow {
  gate: string;
  passed: boolean;
  detail: Record<string, unknown>;
  created_at: string | Date;
}

export async function loadQaResults(versionId: string, sql: postgres.Sql = appDb()): Promise<QaResultRow[]> {
  return sql<QaResultRow[]>`
    select distinct on (gate) gate, passed, detail, created_at from content.qa_results
    where content_version_id = ${versionId} order by gate, created_at desc`;
}

export interface ApprovalDetail extends ApprovalRow {
  requested_at: string | Date;
  decided_at: string | Date | null;
  note: string | null;
  brief: { id: string; spec: BriefSpec; target_answer: string; version: number; status: string; opportunity_title: string | null } | null;
  version: {
    id: string;
    content_item_id: string;
    slug: string;
    version_no: number;
    title: string;
    description: string | null;
    body_md: string;
    body_html: string;
    word_count: number;
    structure_score: Record<string, unknown> | null;
    manifest_version_id: string | null;
  } | null;
}

export async function loadApprovalDetail(approvalId: string, sql: postgres.Sql = appDb()): Promise<ApprovalDetail | null> {
  const [a] = await sql<(ApprovalRow & { requested_at: string | Date; decided_at: string | Date | null; note: string | null })[]>`
    select id, org_id, site_id, kind, brief_id, content_version_id, status, slack_channel, slack_ts, expires_at, requested_at, decided_at, note
    from content.approvals where id = ${approvalId}`;
  if (!a) return null;
  const [brief] = a.brief_id
    ? await sql<NonNullable<ApprovalDetail["brief"]>[]>`
        select b.id, b.spec, b.target_answer, b.version, b.status, o.title as opportunity_title
        from content.briefs b left join content.opportunities o on o.id = b.opportunity_id where b.id = ${a.brief_id}`
    : [];
  const [version] = a.content_version_id
    ? await sql<NonNullable<ApprovalDetail["version"]>[]>`
        select v.id, v.content_item_id, ci.slug, v.version_no, v.title, v.description, v.body_md, v.body_html, v.word_count, v.structure_score, v.manifest_version_id
        from content.content_versions v join content.content_items ci on ci.id = v.content_item_id where v.id = ${a.content_version_id}`
    : [];
  return { ...a, brief: brief ?? null, version: version ?? null };
}

export interface VersionDetail {
  id: string;
  org_id: string;
  site_id: string;
  content_item_id: string;
  slug: string;
  item_status: string;
  version_no: number;
  title: string;
  description: string | null;
  body_md: string;
  body_html: string;
  frontmatter: Record<string, unknown>;
  schema_jsonld: unknown;
  structure_score: Record<string, unknown> | null;
  word_count: number;
  created_at: string | Date;
}

export async function loadVersionDetail(versionId: string, sql: postgres.Sql = appDb()): Promise<VersionDetail | null> {
  const [row] = await sql<VersionDetail[]>`
    select v.id, v.org_id, ci.site_id, v.content_item_id, ci.slug, ci.status as item_status, v.version_no, v.title, v.description,
           v.body_md, v.body_html, v.frontmatter, v.schema_jsonld, v.structure_score, v.word_count, v.created_at
    from content.content_versions v join content.content_items ci on ci.id = v.content_item_id where v.id = ${versionId}`;
  return row ?? null;
}

export async function listVersionsForItem(itemId: string, sql: postgres.Sql = appDb()): Promise<{ id: string; version_no: number; title: string; word_count: number; created_at: string | Date }[]> {
  return sql<{ id: string; version_no: number; title: string; word_count: number; created_at: string | Date }[]>`
    select id, version_no, title, word_count, created_at from content.content_versions where content_item_id = ${itemId} order by version_no desc`;
}
