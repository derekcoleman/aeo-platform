import { defaultEmbedder } from "@/lib/ai/embed";
import { ScoredJsonError } from "@/lib/ai/scored-json";
import { chunkDocument } from "@/lib/context/chunk";
import { ensureBrandEntity } from "@/lib/context/entities";
import { extractFacts, FACT_EXTRACTION_PROMPT_VERSION, upsertCandidateFacts } from "@/lib/context/facts";
import { redact } from "@/lib/context/redact";
import { scanSignals } from "@/lib/context/signals";
import { listUnchunkedDocuments, listUnextractedDocuments, markFactsExtracted, redactDocument, replaceChunks, type EmbeddedChunk } from "@/lib/context/store";
import { appDb } from "@/lib/db/app";
import { modelFor } from "@/lib/pipeline/model";
import {
  connectorSyncCompleted,
  contextFactsExtractCompleted,
  contextFactsExtractRequested,
  contextIngestCompleted,
  contextIngestRequested,
  contextSignalsScanRequested,
  inngest,
} from "./client";

/**
 * Brand-brain jobs. Ingest runs after every successful connector sync
 * (redact → chunk → embed, per document, in batches so one step never
 * outgrows a function limit), fact extraction follows when a model key is
 * configured, and the signal scan runs nightly per site. Per-org
 * concurrency of 1 keeps a backfill from starving everyone else.
 */

const INGEST_BATCH = 50;
const INGEST_MAX_BATCHES = 20;
const EXTRACT_BATCH = 8;
const EXTRACT_MAX_DOCS = 160;

export const contextIngestFunction = inngest.createFunction(
  {
    id: "context-ingest",
    triggers: [
      { event: connectorSyncCompleted, if: "event.data.ok == true && event.data.documentsIngested > 0" },
      contextIngestRequested,
    ],
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: 5 }],
    retries: 2,
  },
  async ({ event, step }) => {
    const orgId = event.data.orgId;
    let documents = 0;
    let chunks = 0;
    let embedded = 0;
    let remaining = 0;
    for (let batch = 1; batch <= INGEST_MAX_BATCHES; batch++) {
      const r = await step.run(`ingest:${batch}`, async () => {
        const sql = appDb();
        const embedder = defaultEmbedder();
        const docs = await listUnchunkedDocuments(orgId, INGEST_BATCH, sql);
        let n = 0;
        let c = 0;
        let e = 0;
        for (const doc of docs) {
          // Redaction first, always; a chunk is only ever derived from redacted text.
          const red = redact(doc.text);
          if (red.changed || !doc.redacted) await redactDocument(doc, red.text, red.counts, sql);
          const pieces = chunkDocument({ ...doc, text: red.text });
          let vectors: number[][] | null = null;
          if (pieces.length) {
            try {
              vectors = await embedder.embed(pieces.map((p) => p.text));
            } catch (err) {
              // Retrieval degrades to FTS for these chunks; the row records no model so a later pass can embed them.
              console.warn(`[context] embedding failed for document ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
              vectors = null;
            }
          }
          const rows: EmbeddedChunk[] = pieces.map((p, i) => ({ ...p, embedding: vectors?.[i] ?? null }));
          c += await replaceChunks(doc, rows, vectors ? embedder.id : null, sql);
          if (vectors) e += rows.length;
          n++;
        }
        return { n, c, e, more: docs.length === INGEST_BATCH };
      });
      documents += r.n;
      chunks += r.c;
      embedded += r.e;
      if (!r.more) break;
      if (batch === INGEST_MAX_BATCHES) remaining = 1;
    }
    await step.sendEvent("completed", contextIngestCompleted.create({ orgId, documents, chunks, embedded, remaining }));
    // Facts need a model; without a key the candidates simply wait.
    if (documents > 0 && process.env.ANTHROPIC_API_KEY) {
      await step.sendEvent("extract", contextFactsExtractRequested.create({ orgId }));
    }
    return { orgId, documents, chunks, embedded, remaining };
  },
);

export const contextExtractFactsFunction = inngest.createFunction(
  {
    id: "context-extract-facts",
    triggers: [contextFactsExtractRequested],
    concurrency: [{ key: "event.data.orgId", limit: 1 }, { limit: 3 }],
    retries: 1,
  },
  async ({ event, step }) => {
    const { orgId, siteId = null, maxDocuments = EXTRACT_MAX_DOCS } = event.data;
    if (!process.env.ANTHROPIC_API_KEY) return { orgId, skipped: "ANTHROPIC_API_KEY is not set" as const };

    const brand = await step.run("brand", async () => {
      const sql = appDb();
      const entity = await ensureBrandEntity(orgId, siteId, sql);
      const [site] = siteId ? await sql<{ canonical_domain: string }[]>`select canonical_domain from app.sites where id = ${siteId} and org_id = ${orgId}` : [];
      return { entity, domain: site?.canonical_domain ?? null };
    });

    let documents = 0;
    let candidates = 0;
    let remaining = 0;
    const batches = Math.ceil(maxDocuments / EXTRACT_BATCH);
    for (let batch = 1; batch <= batches; batch++) {
      const r = await step.run(`extract:${batch}`, async () => {
        const sql = appDb();
        const docs = await listUnextractedDocuments(orgId, EXTRACT_BATCH, siteId, sql);
        if (docs.length === 0) return { n: 0, c: 0, more: false };
        let c = 0;
        try {
          const { facts, run } = await extractFacts(modelFor("context.facts.extract"), docs, { name: brand.entity.name, domain: brand.domain }, { orgId, siteId }, sql);
          const summary = await upsertCandidateFacts(orgId, siteId, facts, docs, { model: run.model, promptVersion: run.promptVersion }, sql, brand.entity);
          c = summary.inserted + summary.merged;
        } catch (err) {
          // Malformed model output is not worth retrying on the same documents; mark them and move on.
          if (!(err instanceof ScoredJsonError)) throw err;
          console.warn(`[context] fact extraction returned unusable JSON for org ${orgId} (${FACT_EXTRACTION_PROMPT_VERSION}): ${err.message}`);
        }
        await markFactsExtracted(docs, sql);
        return { n: docs.length, c, more: docs.length === EXTRACT_BATCH };
      });
      documents += r.n;
      candidates += r.c;
      if (!r.more) break;
      if (batch === batches) remaining = 1;
    }
    if (remaining) await step.sendEvent("continue", contextFactsExtractRequested.create({ orgId, siteId, maxDocuments }));
    await step.sendEvent("completed", contextFactsExtractCompleted.create({ orgId, documents, candidates, remaining }));
    return { orgId, documents, candidates, remaining };
  },
);

export const contextSignalsScanFunction = inngest.createFunction(
  { id: "context-signals-scan", triggers: [contextSignalsScanRequested], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 1 },
  async ({ event, step }) => step.run("scan", () => scanSignals(event.data.orgId, event.data.siteId)),
);

/** Daily, after the connector syncs and ingest: every active site gets its detectors run. */
export const contextSignalsDaily = inngest.createFunction(
  { id: "context-signals-daily", triggers: [{ cron: "0 8 * * *" }], retries: 0 },
  async ({ step }) => {
    const sites = await step.run("list-sites", () => appDb()<{ id: string; org_id: string }[]>`select id, org_id from app.sites where status = 'active'`);
    if (sites.length === 0) return { sites: 0 };
    await step.sendEvent("fan-out", sites.map((s) => contextSignalsScanRequested.create({ siteId: s.id, orgId: s.org_id })));
    return { sites: sites.length };
  },
);

export const contextFunctions = [contextIngestFunction, contextExtractFactsFunction, contextSignalsScanFunction, contextSignalsDaily];
