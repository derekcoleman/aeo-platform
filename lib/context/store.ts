import type postgres from "postgres";
import { vectorLiteral } from "@/lib/ai/embed";
import { appDb } from "@/lib/db/app";
import type { ChunkInput, ContextDocument } from "./types";

/**
 * Persistence for ingest. Everything runs on the service connection and
 * scopes by org_id explicitly; the document's own org_id is the source of
 * truth for every child row via the 0007 trigger.
 */


/** Documents whose chunks are missing or derived from an older provider text. */
export async function listUnchunkedDocuments(orgId: string, limit = 50, sql: postgres.Sql = appDb()): Promise<ContextDocument[]> {
  return sql<ContextDocument[]>`
    select id, org_id, site_id, provider, kind, title, text, metadata, source_ts, content_sha256, redacted from context.context_documents
    where org_id = ${orgId} and chunked_sha256 is distinct from content_sha256
      and (retention_until is null or retention_until > now())
    order by source_ts desc nulls last, created_at desc limit ${limit}`;
}

/** Redacted, chunked documents that have not had facts extracted from their current text. */
export async function listUnextractedDocuments(orgId: string, limit = 8, siteId: string | null = null, sql: postgres.Sql = appDb()): Promise<ContextDocument[]> {
  return sql<ContextDocument[]>`
    select id, org_id, site_id, provider, kind, title, text, metadata, source_ts, content_sha256, redacted from context.context_documents
    where org_id = ${orgId} and redacted and chunked_sha256 = content_sha256
      and facts_sha256 is distinct from content_sha256
      and (${siteId}::uuid is null or site_id is null or site_id = ${siteId})
      and (retention_until is null or retention_until > now())
    order by source_ts desc nulls last, created_at desc limit ${limit}`;
}

/**
 * Rewrite the text in place and mark it redacted. content_sha256 is left as
 * the hash of the provider text on purpose (see the 0007 column comment):
 * re-hashing would make the next sync see a "change" and un-redact the row.
 */
export async function redactDocument(doc: Pick<ContextDocument, "id" | "org_id">, text: string, counts: Record<string, number>, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`
    update context.context_documents
    set text = ${text}, redacted = true,
        metadata = metadata || jsonb_build_object('redaction', ${sql.json(counts as never)}::jsonb),
        updated_at = now()
    where id = ${doc.id} and org_id = ${doc.org_id}`;
}

export interface EmbeddedChunk extends ChunkInput {
  embedding: number[] | null;
}

/** Replace a document's chunks atomically and record which provider text they derive from. */
export async function replaceChunks(
  doc: Pick<ContextDocument, "id" | "org_id" | "content_sha256">,
  chunks: EmbeddedChunk[],
  embeddingModel: string | null,
  sql: postgres.Sql = appDb(),
): Promise<number> {
  await sql.begin(async (tx) => {
    await tx`delete from context.context_chunks where document_id = ${doc.id} and org_id = ${doc.org_id}`;
    for (const c of chunks) {
      const embedded = c.embedding && embeddingModel ? true : false;
      await tx`
        insert into context.context_chunks (org_id, document_id, ordinal, text, token_estimate, embedding, embedding_model, metadata)
        values (${doc.org_id}, ${doc.id}, ${c.ordinal}, ${c.text}, ${c.tokenEstimate},
                ${embedded ? vectorLiteral(c.embedding!) : null}, ${embedded ? embeddingModel : null}, ${tx.json(c.metadata as never)})`;
    }
    await tx`
      update context.context_documents set chunked_sha256 = ${doc.content_sha256}, chunked_at = now(), updated_at = now()
      where id = ${doc.id} and org_id = ${doc.org_id}`;
  });
  return chunks.length;
}

export async function markFactsExtracted(docs: Pick<ContextDocument, "id" | "org_id" | "content_sha256">[], sql: postgres.Sql = appDb()): Promise<void> {
  for (const d of docs) {
    await sql`
      update context.context_documents set facts_sha256 = ${d.content_sha256}, facts_extracted_at = now(), updated_at = now()
      where id = ${d.id} and org_id = ${d.org_id}`;
  }
}

export interface DocumentProvenance {
  id: string;
  provider: string;
  kind: string;
  title: string | null;
  source_ts: string | Date | null;
  metadata: Record<string, unknown>;
}

export async function loadDocumentsForProvenance(orgId: string, ids: string[], sql: postgres.Sql = appDb()): Promise<DocumentProvenance[]> {
  if (ids.length === 0) return [];
  return sql<DocumentProvenance[]>`
    select id, provider, kind, title, source_ts, metadata from context.context_documents
    where org_id = ${orgId} and id = any(${sql.array(ids)}::uuid[])`;
}
