import { z } from "zod";

/**
 * Shapes shared across the brand brain. The zod enums mirror the SQL enums in
 * 0007 one-to-one; a value the model invents fails here, not at the insert.
 */

export const factTypeSchema = z.enum([
  "positioning", "product_capability", "pricing", "integration", "customer_proof", "metric",
  "objection", "icp_pain", "differentiator", "launch", "terminology", "banned_claim", "competitor_claim",
]);
export type FactType = z.infer<typeof factTypeSchema>;

export const factStatusSchema = z.enum(["candidate", "verified", "rejected", "superseded"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

export const factVisibilitySchema = z.enum(["public", "internal"]);
export type FactVisibility = z.infer<typeof factVisibilitySchema>;

export const entityTypeSchema = z.enum(["brand", "product", "feature", "competitor", "integration", "customer", "person", "category", "other"]);
export type EntityType = z.infer<typeof entityTypeSchema>;

export const signalKindSchema = z.enum(["term_spike", "unanswered_question", "competitor_spike"]);
export type SignalKind = z.infer<typeof signalKindSchema>;

export interface EntityRow {
  id: string;
  org_id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  wikidata_id: string | null;
  description: string | null;
}

export interface FactRow {
  id: string;
  org_id: string;
  site_id: string | null;
  type: FactType;
  subject_entity_id: string | null;
  subject_text: string;
  predicate: string;
  object_text: string;
  value_numeric: number | null;
  unit: string | null;
  confidence: number;
  effective_from: string | null;
  effective_to: string | null;
  status: FactStatus;
  visibility: FactVisibility;
  source_document_ids: string[];
  source_quote: string | null;
  supersedes_id: string | null;
  dedupe_key: string;
}

/** A document as the ingest job sees it: enough to redact, chunk and attribute. */
export interface ContextDocument {
  id: string;
  org_id: string;
  site_id: string | null;
  provider: "slack" | "google" | "profound";
  kind: string;
  title: string | null;
  text: string;
  metadata: Record<string, unknown>;
  source_ts: string | Date | null;
  content_sha256: string;
  redacted: boolean;
}

export interface ChunkInput {
  ordinal: number;
  text: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
}
