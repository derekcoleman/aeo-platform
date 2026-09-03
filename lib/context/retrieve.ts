import type postgres from "postgres";
import { defaultEmbedder, EMBEDDING_DIMENSIONS, vectorLiteral, type Embedder } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import { buildAliasIndex, findEntityMentions, listEntities } from "./entities";
import { factKey, listVerifiedFacts, renderFact } from "./facts";
import { loadActiveManifest, manifestPromptBlock, type ManifestRow } from "./manifest";
import type { EntityRow, FactRow, FactType } from "./types";

/**
 * One `retrieveContext()` for every generation stage. Vector top-N ∪ FTS
 * top-N → reciprocal rank fusion → recency decay on Slack chunks → assembled
 * with provenance. Verified facts for the brand and any entity the query
 * mentions are ALWAYS included regardless of vector score: they are the
 * precise layer, and their ids are what the draft cites as {{fact:key}}.
 *
 * Deterministic given the same rows: same query, same embedder, same
 * clock → same block, so a brief is reproducible under its manifest.
 */

export interface RetrievedChunk {
  id: string;
  documentId: string;
  text: string;
  score: number;
  provider: string;
  kind: string;
  title: string | null;
  sourceTs: string | null;
  metadata: Record<string, unknown>;
}

export interface RetrieveOptions {
  embedder?: Embedder;
  /** Chunks returned after fusion. */
  k?: number;
  /** Candidates pulled from each of the vector and FTS halves before fusion. */
  candidates?: number;
  asOf?: Date;
  slackHalfLifeDays?: number;
  factTypes?: FactType[];
  factLimit?: number;
  sql?: postgres.Sql;
}

export interface RetrievedContext {
  chunks: RetrievedChunk[];
  facts: FactRow[];
  manifest: ManifestRow | null;
  entitiesMentioned: EntityRow[];
  stats: { vectorCandidates: number; ftsCandidates: number; fused: number; embedded: boolean; embeddingModel: string | null };
}

export const RRF_K = 60;

/** Reciprocal rank fusion over ranked id lists: sum(1 / (K + rank)). */
export function rrfFuse(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return scores;
}

/** Exponential decay with the given half-life; undated rows decay as if brand new. */
export function recencyDecay(sourceTs: string | Date | null, asOf: Date, halfLifeDays: number): number {
  if (!sourceTs) return 1;
  const ageDays = Math.max(0, (asOf.getTime() - new Date(sourceTs).getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

const FACT_TYPE_PRIORITY: FactType[] = ["positioning", "differentiator", "product_capability", "launch", "pricing", "integration", "customer_proof", "metric", "terminology", "icp_pain", "objection", "competitor_claim", "banned_claim"];

interface CandidateRow {
  id: string;
  document_id: string;
  text: string;
  vec_rank: number | null;
  fts_rank: number | null;
  provider: string;
  kind: string;
  title: string | null;
  source_ts: string | null;
  site_id: string | null;
  metadata: Record<string, unknown>;
}

export async function retrieveContext(scope: { orgId: string; siteId: string | null }, query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext> {
  const sql = opts.sql ?? appDb();
  const embedder = opts.embedder ?? defaultEmbedder();
  const k = opts.k ?? 8;
  const candidates = opts.candidates ?? 30;
  const asOf = opts.asOf ?? new Date();
  const halfLife = opts.slackHalfLifeDays ?? 90;
  const q = query.trim();

  // The vector half only makes sense when the embedder matches the column
  // width; the hash fallback at 1536 dims is fine, a 256-dim test embedder is not.
  let queryVector: number[] | null = null;
  if (q && embedder.dimensions === EMBEDDING_DIMENSIONS) {
    try {
      queryVector = (await embedder.embed([q]))[0] ?? null;
    } catch {
      queryVector = null;
    }
  }

  const rows = q
    ? await sql.begin(async (tx) => {
        await tx`set local hnsw.ef_search = 200`;
        return tx<CandidateRow[]>`
          with vec as (
            select c.id, row_number() over (order by c.embedding <=> ${queryVector ? vectorLiteral(queryVector) : null}::vector) as r
            from context.context_chunks c join context.context_documents d on d.id = c.document_id
            where ${queryVector !== null} and c.org_id = ${scope.orgId} and c.embedding is not null and c.embedding_model = ${embedder.id}
              and (d.site_id is null or d.site_id = ${scope.siteId})
              and (d.retention_until is null or d.retention_until > now())
            order by c.embedding <=> ${queryVector ? vectorLiteral(queryVector) : null}::vector
            limit ${candidates}
          ),
          fts as (
            select c.id, row_number() over (order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${q})) desc) as r
            from context.context_chunks c join context.context_documents d on d.id = c.document_id
            where c.org_id = ${scope.orgId} and c.tsv @@ websearch_to_tsquery('english', ${q})
              and (d.site_id is null or d.site_id = ${scope.siteId})
              and (d.retention_until is null or d.retention_until > now())
            order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${q})) desc
            limit ${candidates}
          ),
          ids as (select id from vec union select id from fts)
          select c.id, c.document_id, c.text, vec.r::int as vec_rank, fts.r::int as fts_rank,
                 d.provider::text as provider, d.kind, d.title, d.source_ts::text as source_ts, d.site_id, c.metadata
          from ids join context.context_chunks c on c.id = ids.id
          join context.context_documents d on d.id = c.document_id
          left join vec on vec.id = c.id left join fts on fts.id = c.id
          where c.org_id = ${scope.orgId}`;
      })
    : [];

  const vecList = rows.filter((r) => r.vec_rank != null).sort((a, b) => a.vec_rank! - b.vec_rank!).map((r) => r.id);
  const ftsList = rows.filter((r) => r.fts_rank != null).sort((a, b) => a.fts_rank! - b.fts_rank!).map((r) => r.id);
  const fused = rrfFuse([vecList, ftsList]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chunks: RetrievedChunk[] = [...fused.entries()]
    .map(([id, base]) => {
      const r = byId.get(id)!;
      const decay = r.provider === "slack" ? recencyDecay(r.source_ts, asOf, halfLife) : 1;
      return {
        id: r.id,
        documentId: r.document_id,
        text: r.text,
        score: Math.round(base * decay * 1e6) / 1e6,
        provider: r.provider,
        kind: r.kind,
        title: r.title,
        sourceTs: r.source_ts,
        metadata: r.metadata ?? {},
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);

  // Entities the query (and the chunks we kept) mention, by alias, never substring.
  const entities = await listEntities(scope.orgId, sql);
  const index = buildAliasIndex(entities);
  const mentionText = [q, ...chunks.map((c) => c.text)].join("\n");
  const brand = entities.filter((e) => e.type === "brand");
  const mentioned = findEntityMentions(index, mentionText).map((m) => m.entity);
  const entityIds = [...new Set([...brand, ...mentioned].map((e) => e.id))];

  const facts = entityIds.length
    ? await listVerifiedFacts(scope.orgId, { siteId: scope.siteId, entityIds, types: opts.factTypes, asOf, limit: opts.factLimit ?? 25 }, sql)
    : [];
  facts.sort((a, b) => FACT_TYPE_PRIORITY.indexOf(a.type) - FACT_TYPE_PRIORITY.indexOf(b.type) || b.confidence - a.confidence);

  const manifest = await loadActiveManifest(scope.orgId, scope.siteId, sql);

  return {
    chunks,
    facts,
    manifest,
    entitiesMentioned: mentioned,
    stats: { vectorCandidates: vecList.length, ftsCandidates: ftsList.length, fused: fused.size, embedded: queryVector !== null, embeddingModel: queryVector ? embedder.id : null },
  };
}

export interface ContextBlockOptions {
  maxChunkChars?: number;
  includeManifest?: boolean;
}

/**
 * The retrieved context as prompt text with provenance on every line, so a
 * model can attribute what it uses and a reviewer can trace it back.
 * Internal facts are labelled; the brief decides what the draft may cite.
 */
export function formatContextBlock(ctx: RetrievedContext, opts: ContextBlockOptions = {}): string {
  const parts: string[] = [];
  if (opts.includeManifest !== false && ctx.manifest) parts.push(`Brand manifesto (v${ctx.manifest.version}):\n${manifestPromptBlock(ctx.manifest.doc)}`);
  if (ctx.facts.length) {
    parts.push(`Verified facts (cite public ones as {{fact:key}}):\n${ctx.facts.map((f) => `- {{fact:${factKey(f)}}} [${f.type}, ${f.visibility}] ${renderFact(f)}`).join("\n")}`);
  }
  if (ctx.chunks.length) {
    const max = opts.maxChunkChars ?? 1200;
    parts.push(
      `Internal context (background only — never quote or cite directly; nothing here is a source):\n${ctx.chunks
        .map((c, i) => `[${i + 1}] ${c.provider}/${c.kind}${c.title ? ` "${c.title}"` : ""}${c.sourceTs ? ` ${c.sourceTs.slice(0, 10)}` : ""}\n${c.text.length > max ? `${c.text.slice(0, max - 1)}…` : c.text}`)
        .join("\n\n")}`,
    );
  }
  return parts.join("\n\n");
}
