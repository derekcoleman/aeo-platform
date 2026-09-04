import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { ManifestRow } from "@/lib/context/manifest";
import type { FactType } from "@/lib/context/types";

/**
 * Read models for the Brain page: what is connected and how much of it has
 * been ingested, plus the manifest history. Fact and entity reads come from
 * lib/context directly; these are the joins that module does not own.
 */

export interface BrainSourceRow {
  connection_id: string | null;
  provider: string;
  external_account_name: string | null;
  status: string;
  last_synced_at: string | Date | null;
  last_error: string | null;
  documents: number;
  chunked: number;
  facts_extracted: number;
  latest_source_ts: string | Date | null;
}

export async function brainSources(orgId: string, sql: postgres.Sql = appDb()): Promise<BrainSourceRow[]> {
  return sql<BrainSourceRow[]>`
    select c.id as connection_id, c.provider, c.external_account_name, c.status, c.last_synced_at, c.last_error,
           count(d.id)::int as documents,
           count(d.id) filter (where d.chunked_sha256 = d.content_sha256)::int as chunked,
           count(d.id) filter (where d.facts_sha256 = d.content_sha256)::int as facts_extracted,
           max(d.source_ts) as latest_source_ts
    from context.context_connections c
    left join context.context_documents d on d.connection_id = c.id
    where c.org_id = ${orgId}
    group by c.id, c.provider, c.external_account_name, c.status, c.last_synced_at, c.last_error
    order by c.provider`;
}

export interface BrainCounts {
  candidates: number;
  verified: number;
  rejected: number;
  entities: number;
  chunks: number;
  signals_new: number;
}

export async function brainCounts(orgId: string, sql: postgres.Sql = appDb()): Promise<BrainCounts> {
  const [row] = await sql<BrainCounts[]>`
    select (select count(*)::int from context.brand_facts where org_id = ${orgId} and status = 'candidate') as candidates,
           (select count(*)::int from context.brand_facts where org_id = ${orgId} and status = 'verified') as verified,
           (select count(*)::int from context.brand_facts where org_id = ${orgId} and status = 'rejected') as rejected,
           (select count(*)::int from context.entities where org_id = ${orgId}) as entities,
           (select count(*)::int from context.context_chunks where org_id = ${orgId}) as chunks,
           (select count(*)::int from context.signals where org_id = ${orgId} and status = 'new') as signals_new`;
  return row ?? { candidates: 0, verified: 0, rejected: 0, entities: 0, chunks: 0, signals_new: 0 };
}

export async function listManifests(orgId: string, sql: postgres.Sql = appDb()): Promise<(ManifestRow & { created_at: string | Date })[]> {
  return sql<(ManifestRow & { created_at: string | Date })[]>`
    select id, org_id, site_id, version, status, doc, activated_at, created_at
    from context.brand_manifests where org_id = ${orgId} order by version desc limit 20`;
}

export interface SignalRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  score: number;
  seen_count: number;
  last_seen_at: string | Date;
}

export async function listSignals(orgId: string, siteId: string, limit = 20, sql: postgres.Sql = appDb()): Promise<SignalRow[]> {
  return sql<SignalRow[]>`
    select id, kind, status, title, score::float as score, seen_count, last_seen_at
    from context.signals where org_id = ${orgId} and site_id = ${siteId} and status <> 'dismissed'
    order by (status = 'new') desc, score desc, last_seen_at desc limit ${limit}`;
}

export const FACT_TYPE_LABEL: Record<FactType, string> = {
  positioning: "Positioning",
  product_capability: "Capability",
  pricing: "Pricing",
  integration: "Integration",
  customer_proof: "Customer proof",
  metric: "Metric",
  objection: "Objection",
  icp_pain: "ICP pain",
  differentiator: "Differentiator",
  launch: "Launch",
  terminology: "Terminology",
  banned_claim: "Banned claim",
  competitor_claim: "Competitor claim",
};
