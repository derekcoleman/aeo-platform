import type postgres from "postgres";
import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { appDb } from "@/lib/db/app";
import { runJsonTask } from "@/lib/pipeline/model";
import type { ModelRun } from "@/lib/pipeline/types";
import { buildAliasIndex, listEntities, resolveEntityByName, upsertEntity } from "./entities";
import { entityTypeSchema, factTypeSchema, factVisibilitySchema, type ContextDocument, type EntityRow, type FactRow, type FactType } from "./types";

/**
 * Layer 2: facts. A cheap model turns redacted documents into atomic, typed,
 * dated, sourced claims; a human verifies them; only verified facts reach
 * generation. Extraction is idempotent on `dedupe_key` (type + subject +
 * predicate): re-running over the same documents merges into the existing
 * candidate rather than piling up, and a changed object on a verified fact
 * becomes a new candidate that *supersedes* the old one when verified, so
 * "we support SSO" (2024) and "SCIM + SSO" (2026) both survive with dates.
 */

export const FACT_EXTRACTION_PROMPT_VERSION = "facts.extract.v1";

export const extractedFactSchema = z.object({
  type: factTypeSchema,
  subject: z.string().min(1).max(120),
  subjectType: entityTypeSchema.optional(),
  predicate: z.string().min(1).max(120),
  object: z.string().min(1).max(600),
  valueNumeric: z.number().nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  confidence: z.number().min(0).max(1).catch(0.5),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  quote: z.string().min(4).max(600),
  visibility: factVisibilitySchema.catch("internal"),
  /** 1-based indexes into the documents the prompt listed. */
  docRefs: z.array(z.number().int().min(1)).min(1).max(20),
});
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export const factExtractionSchema = z.object({ facts: z.array(extractedFactSchema).max(40) });

export function factExtractionSystemPrompt(): string {
  return [
    "You extract atomic facts about ONE company from its internal documents (Slack threads, exports, notes). Return strict JSON only.",
    "A fact is one claim: subject + predicate + object, with a verbatim supporting quote from the documents. Never infer beyond what a document says; never merge two claims.",
    "Types: positioning, product_capability, pricing, integration, customer_proof, metric, objection (a buyer pushback), icp_pain (a buyer problem), differentiator, launch (something shipped, with a date if given), terminology (how the company names things), banned_claim (something people say must NOT be claimed), competitor_claim (a claim about a competitor).",
    "visibility: 'public' only if the fact could appear in a published article without harm (a capability, a launch, a positioning statement). Customer names, revenue, internal metrics, objections and anything from a private deal are 'internal'.",
    "subject is the entity the claim is about (the company, a product, a feature, a competitor, a customer). subjectType is its kind when it is not the company itself.",
    "confidence reflects how directly the quote supports the claim (1 = states it outright; 0.4 = implied).",
    "Skip chit-chat, opinions with no substance, and anything already redacted ([email], [phone], [secret]).",
  ].join("\n");
}

export function factExtractionPrompt(docs: Pick<ContextDocument, "kind" | "title" | "text" | "source_ts">[], brand: { name: string; domain?: string | null }): string {
  const listed = docs
    .map((d, i) => {
      const when = d.source_ts ? new Date(d.source_ts).toISOString().slice(0, 10) : "undated";
      return `[${i + 1}] (${d.kind}, ${when})${d.title ? ` ${d.title}` : ""}\n${d.text.slice(0, 6000)}`;
    })
    .join("\n\n");
  return [
    `Company: ${brand.name}${brand.domain ? ` (${brand.domain})` : ""}. Refer to it as "${brand.name}" in subject.`,
    `Documents:\n\n${listed}`,
    'Return JSON: { "facts": [{ "type": string, "subject": string, "subjectType"?: string, "predicate": string, "object": string, "valueNumeric"?: number|null, "unit"?: string|null, "confidence": number, "effectiveFrom"?: "YYYY-MM-DD"|null, "quote": string, "visibility": "public"|"internal", "docRefs": [number] }] }',
  ].join("\n\n");
}

export async function extractFacts(
  model: TextModel,
  docs: ContextDocument[],
  brand: { name: string; domain?: string | null },
  scope: { orgId: string; siteId?: string | null },
  sql: postgres.Sql = appDb(),
): Promise<{ facts: ExtractedFact[]; run: ModelRun }> {
  const { value, run } = await runJsonTask(
    "context.facts.extract",
    model,
    { system: factExtractionSystemPrompt(), prompt: factExtractionPrompt(docs, brand), promptVersion: FACT_EXTRACTION_PROMPT_VERSION, maxTokens: 8192, temperature: 0 },
    factExtractionSchema,
    scope,
    sql,
  );
  // A docRef past the end of the list is a hallucination; drop the fact rather than mis-attribute it.
  const facts = value.facts.filter((f) => f.docRefs.every((r) => r <= docs.length));
  return { facts, run };
}

// ── keys ────────────────────────────────────────────────────────────────────

export function slugKey(s: string, max = 60): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

export function factDedupeKey(type: FactType, subjectKey: string, predicate: string): string {
  return `${type}|${slugKey(subjectKey, 60)}|${slugKey(predicate, 60)}`;
}

/** The `{{fact:key}}` handle a draft cites: type-predicate slug plus the id prefix so two facts never collide. */
export function factKey(f: Pick<FactRow, "id" | "type" | "predicate">): string {
  const base = slugKey(`${f.type}-${f.predicate}`, 40).replace(/^-+|-+$/g, "") || "fact";
  return `${base}-${f.id.replace(/-/g, "").slice(0, 4)}`;
}

/** One-line rendering for prompts and previews. */
export function renderFact(f: Pick<FactRow, "subject_text" | "predicate" | "object_text" | "effective_from" | "effective_to">): string {
  const when = f.effective_from ? ` (since ${f.effective_from}${f.effective_to ? `, until ${f.effective_to}` : ""})` : "";
  return `${f.subject_text} ${f.predicate} ${f.object_text}${when}`;
}

function normalizeObject(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isEffective(f: Pick<FactRow, "effective_from" | "effective_to">, asOf: Date = new Date()): boolean {
  const day = asOf.toISOString().slice(0, 10);
  if (f.effective_from && f.effective_from > day) return false;
  if (f.effective_to && f.effective_to < day) return false;
  return true;
}

// ── persistence ─────────────────────────────────────────────────────────────


export interface UpsertFactsSummary {
  inserted: number;
  merged: number;
  unchanged: number;
  entitiesCreated: number;
}

/**
 * Extracted facts → candidate rows. Subject resolves through the alias index
 * (exact, never substring); an unknown typed subject becomes a new entity.
 * A candidate whose (type, subject, predicate) already has a verified fact
 * with the same object is a no-op; a different object becomes a candidate
 * that points at the verified row via supersedes_id.
 */
export async function upsertCandidateFacts(
  orgId: string,
  siteId: string | null,
  facts: ExtractedFact[],
  docs: Pick<ContextDocument, "id">[],
  meta: { model: string; promptVersion: string },
  sql: postgres.Sql = appDb(),
  brand?: EntityRow,
): Promise<UpsertFactsSummary> {
  const summary: UpsertFactsSummary = { inserted: 0, merged: 0, unchanged: 0, entitiesCreated: 0 };
  let index = buildAliasIndex(await listEntities(orgId, sql));
  for (const f of facts) {
    let entity = resolveEntityByName(index, f.subject) ?? (brand && normalizeObject(f.subject) === normalizeObject(brand.name) ? brand : null);
    if (!entity && f.subjectType && f.subjectType !== "brand") {
      entity = await upsertEntity(orgId, { type: f.subjectType, name: f.subject }, sql);
      summary.entitiesCreated++;
      index = buildAliasIndex([...index.entities, entity]);
    }
    const subjectText = entity?.name ?? f.subject.trim();
    const dedupeKey = factDedupeKey(f.type, entity?.id ?? subjectText, f.predicate);
    const sourceIds = [...new Set(f.docRefs.map((r) => docs[r - 1]?.id).filter((x): x is string => !!x))];
    const [verified] = await sql<Pick<FactRow, "id" | "object_text">[]>`
      select id, object_text from context.brand_facts where org_id = ${orgId} and dedupe_key = ${dedupeKey} and status = 'verified'`;
    if (verified && normalizeObject(verified.object_text) === normalizeObject(f.object)) {
      // Same claim, new evidence: extend provenance and move on.
      await sql`
        update context.brand_facts
        set source_document_ids = (select array_agg(distinct d) from unnest(source_document_ids || ${sql.array(sourceIds)}::uuid[]) as d), updated_at = now()
        where id = ${verified.id} and org_id = ${orgId}`;
      summary.unchanged++;
      continue;
    }
    const [row] = await sql<{ inserted: boolean }[]>`
      insert into context.brand_facts
        (org_id, site_id, type, subject_entity_id, subject_text, predicate, object_text, value_numeric, unit, confidence, effective_from,
         status, visibility, source_document_ids, source_quote, extracted_by_model, prompt_version, supersedes_id, dedupe_key)
      values (${orgId}, ${siteId}, ${f.type}, ${entity?.id ?? null}, ${subjectText}, ${f.predicate.trim()}, ${f.object.trim()},
              ${f.valueNumeric ?? null}, ${f.unit ?? null}, ${f.confidence}, ${f.effectiveFrom ?? null},
              'candidate', ${f.visibility}, ${sql.array(sourceIds)}::uuid[], ${f.quote}, ${meta.model}, ${meta.promptVersion}, ${verified?.id ?? null}, ${dedupeKey})
      on conflict (org_id, dedupe_key) where status = 'candidate' do update
        set object_text = case when excluded.confidence > context.brand_facts.confidence then excluded.object_text else context.brand_facts.object_text end,
            value_numeric = case when excluded.confidence > context.brand_facts.confidence then excluded.value_numeric else context.brand_facts.value_numeric end,
            source_quote = case when excluded.confidence > context.brand_facts.confidence then excluded.source_quote else context.brand_facts.source_quote end,
            confidence = greatest(context.brand_facts.confidence, excluded.confidence),
            effective_from = coalesce(context.brand_facts.effective_from, excluded.effective_from),
            visibility = case when context.brand_facts.visibility = 'internal' or excluded.visibility = 'internal' then 'internal' else 'public' end,
            source_document_ids = (select array_agg(distinct d) from unnest(context.brand_facts.source_document_ids || excluded.source_document_ids) as d),
            updated_at = now()
      returning (xmax = 0) as inserted`;
    if (row?.inserted) summary.inserted++;
    else summary.merged++;
  }
  return summary;
}

/** Verify a candidate. If it supersedes a verified fact, that one is marked superseded (and dated out) first so the partial unique holds. */
export async function verifyFact(orgId: string, factId: string, userId: string | null, sql: postgres.Sql = appDb(), now: Date = new Date()): Promise<FactRow | null> {
  return sql.begin(async (tx) => {
    const [fact] = await tx<FactRow[]>`select id, org_id, site_id, type, subject_entity_id, subject_text, predicate, object_text, value_numeric::float as value_numeric, unit, confidence::float as confidence, effective_from::text as effective_from, effective_to::text as effective_to, status, visibility, source_document_ids, source_quote, supersedes_id, dedupe_key from context.brand_facts where id = ${factId} and org_id = ${orgId} for update`;
    if (!fact || fact.status !== "candidate") return null;
    const day = now.toISOString().slice(0, 10);
    await tx`
      update context.brand_facts set status = 'superseded', effective_to = coalesce(effective_to, ${day}::date), updated_at = now()
      where org_id = ${orgId} and status = 'verified' and (id = ${fact.supersedes_id} or dedupe_key = ${fact.dedupe_key})`;
    const [row] = await tx<FactRow[]>`
      update context.brand_facts set status = 'verified', verified_by_user_id = ${userId}, verified_at = ${now}, updated_at = now()
      where id = ${factId} and org_id = ${orgId}
      returning id, org_id, site_id, type, subject_entity_id, subject_text, predicate, object_text, value_numeric::float as value_numeric, unit, confidence::float as confidence, effective_from::text as effective_from, effective_to::text as effective_to, status, visibility, source_document_ids, source_quote, supersedes_id, dedupe_key`;
    return row ?? null;
  });
}

export async function rejectFact(orgId: string, factId: string, reason: string | null, sql: postgres.Sql = appDb()): Promise<boolean> {
  const rows = await sql`
    update context.brand_facts set status = 'rejected', rejected_reason = ${reason}, updated_at = now()
    where id = ${factId} and org_id = ${orgId} and status = 'candidate' returning id`;
  return rows.length > 0;
}

export async function listCandidateFacts(orgId: string, limit = 50, sql: postgres.Sql = appDb()): Promise<FactRow[]> {
  return sql<FactRow[]>`
    select id, org_id, site_id, type, subject_entity_id, subject_text, predicate, object_text, value_numeric::float as value_numeric, unit, confidence::float as confidence, effective_from::text as effective_from, effective_to::text as effective_to, status, visibility, source_document_ids, source_quote, supersedes_id, dedupe_key from context.brand_facts
    where org_id = ${orgId} and status = 'candidate' order by confidence desc, created_at desc limit ${limit}`;
}

export interface VerifiedFactsQuery {
  siteId?: string | null;
  entityIds?: string[];
  types?: FactType[];
  asOf?: Date;
  limit?: number;
}

/** Verified facts, effective as of a date, for an org (optionally narrowed to a site, entities and types). */
export async function listVerifiedFacts(orgId: string, q: VerifiedFactsQuery = {}, sql: postgres.Sql = appDb()): Promise<FactRow[]> {
  const day = (q.asOf ?? new Date()).toISOString().slice(0, 10);
  const entityIds = q.entityIds ?? [];
  const types = q.types ?? [];
  return sql<FactRow[]>`
    select id, org_id, site_id, type, subject_entity_id, subject_text, predicate, object_text, value_numeric::float as value_numeric, unit, confidence::float as confidence, effective_from::text as effective_from, effective_to::text as effective_to, status, visibility, source_document_ids, source_quote, supersedes_id, dedupe_key from context.brand_facts
    where org_id = ${orgId} and status = 'verified'
      and (site_id is null or ${q.siteId ?? null}::uuid is null or site_id = ${q.siteId ?? null})
      and (effective_from is null or effective_from <= ${day}::date)
      and (effective_to is null or effective_to >= ${day}::date)
      and (${entityIds.length === 0} or subject_entity_id = any(${sql.array(entityIds)}::uuid[]))
      and (${types.length === 0} or type = any(${sql.array(types)}::context.fact_type[]))
    order by confidence desc, updated_at desc limit ${q.limit ?? 25}`;
}

export interface FactStatusCheck {
  id: string;
  status: FactRow["status"];
  visibility: FactRow["visibility"];
  effective: boolean;
}

/** For the grounding gate: does each cited fact exist, is it verified, is it in effect today. */
export async function loadFactStatuses(orgId: string, ids: string[], sql: postgres.Sql = appDb(), asOf: Date = new Date()): Promise<FactStatusCheck[]> {
  if (ids.length === 0) return [];
  const rows = await sql<Pick<FactRow, "id" | "status" | "visibility" | "effective_from" | "effective_to">[]>`
    select id, status, visibility, effective_from::text as effective_from, effective_to::text as effective_to
    from context.brand_facts where org_id = ${orgId} and id = any(${sql.array(ids)}::uuid[])`;
  return rows.map((r) => ({ id: r.id, status: r.status, visibility: r.visibility, effective: isEffective(r, asOf) }));
}
