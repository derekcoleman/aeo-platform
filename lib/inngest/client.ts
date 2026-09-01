import { Inngest, eventType } from "inngest";
import { z } from "zod";

/**
 * Typed event catalogue. Every event that crosses a job boundary is declared
 * here (with a runtime schema) so a producer and consumer cannot disagree on
 * shape. Send with `inngest.send(evt.create(data))`.
 */
export const auditRequested = eventType("audit/requested", {
  schema: z.object({
    auditRunId: z.guid(),
    targetUrl: z.string().url(),
    kind: z.enum(["public", "preflight", "monitored"]),
    orgId: z.guid().nullable().optional(),
    siteId: z.guid().nullable().optional(),
    contentPrefix: z.string().nullable().optional(),
  }),
});

export const auditCompleted = eventType("audit/completed", {
  schema: z.object({
    auditRunId: z.guid(),
    domain: z.string(),
    geoScore: z.number(),
    orgId: z.guid().nullable().optional(),
    siteId: z.guid().nullable().optional(),
  }),
});

export const auditFailed = eventType("audit/failed", {
  schema: z.object({
    auditRunId: z.guid(),
    error: z.string(),
    orgId: z.guid().nullable().optional(),
  }),
});

export const inngest = new Inngest({ id: "aeo-platform" });

const localeSchema = z.object({ country: z.string().length(2), language: z.string().min(2).max(5) });

/** Mine a question graph for a site from a seed list (brand-brain terms, competitors, ICP pains). */
export const demandMineRequested = eventType("demand/mine.requested", {
  schema: z.object({
    siteId: z.guid(),
    orgId: z.guid(),
    seeds: z.array(z.string().min(2)).min(1).max(50),
    locale: localeSchema,
    device: z.enum(["desktop", "mobile"]).optional(),
    depth: z.number().int().min(1).max(3).optional(),
    maxQueries: z.number().int().min(1).max(2000).optional(),
    paa: z.boolean().optional(),
    /** Auto-track the top N questions by demand on the weekly tier. */
    trackTop: z.number().int().min(0).max(500).optional(),
  }),
});

export const demandMineCompleted = eventType("demand/mine.completed", {
  schema: z.object({
    siteId: z.guid(),
    orgId: z.guid(),
    inserted: z.number(),
    updated: z.number(),
    queriesIssued: z.number(),
    costUsd: z.number(),
  }),
});

/** Snapshot the SERP (AI Overview, featured snippet, organic, PAA) for a set of questions. */
export const serpTrackRequested = eventType("serp/track.requested", {
  schema: z.object({
    siteId: z.guid(),
    orgId: z.guid(),
    questionIds: z.array(z.guid()).min(1).max(200),
  }),
});

export const serpTrackCompleted = eventType("serp/track.completed", {
  schema: z.object({
    siteId: z.guid(),
    orgId: z.guid(),
    snapshots: z.number(),
    aioTriggered: z.number(),
    ownedCitations: z.number(),
    costUsd: z.number(),
  }),
});

// ── connectors ──────────────────────────────────────────────────────────────

const syncKindSchema = z.enum(["backfill", "incremental", "webhook", "upload"]);

/** Run one sync for one connection. `payload` carries the webhook event or upload body. */
export const connectorSyncRequested = eventType("connector/sync.requested", {
  schema: z.object({
    connectionId: z.guid(),
    orgId: z.guid(),
    kind: syncKindSchema,
    payload: z.unknown().optional(),
  }),
});

export const connectorSyncCompleted = eventType("connector/sync.completed", {
  schema: z.object({
    connectionId: z.guid(),
    orgId: z.guid(),
    provider: z.enum(["slack", "google", "profound"]),
    kind: syncKindSchema,
    ok: z.boolean(),
    documentsIngested: z.number().int(),
    metricsIngested: z.number().int(),
    error: z.string().nullable().optional(),
  }),
});

/** A verified, deduped inbound webhook. The route wrote ops.webhook_events and returned 200 already. */
export const connectorWebhookReceived = eventType("connector/webhook.received", {
  schema: z.object({
    provider: z.enum(["slack", "google", "profound"]),
    externalId: z.string().min(1),
    connectionId: z.guid().nullable().optional(),
    orgId: z.guid().nullable().optional(),
    payload: z.unknown(),
  }),
});

/** A human decided on a brief/draft — from Slack Block Kit, the app, or ops. Resolves the pipeline's waitForEvent gate. */
export const approvalDecided = eventType("approval/decided", {
  schema: z.object({
    approvalId: z.guid(),
    decision: z.enum(["approve", "changes", "regenerate"]),
    by: z.object({ userId: z.string().nullable().optional(), name: z.string().nullable().optional() }),
    source: z.enum(["slack", "app", "ops"]),
    note: z.string().nullable().optional(),
    orgId: z.guid().nullable().optional(),
  }),
});

// ── content pipeline ────────────────────────────────────────────────────────

/** Run one opportunity through brief → (gate) → draft → QA → (gate) → publish → post-publish loop. */
export const contentPipelineRequested = eventType("content/pipeline.requested", {
  schema: z.object({
    opportunityId: z.guid(),
    siteId: z.guid(),
    orgId: z.guid(),
    /** An operator's steer, carried into the brief prompt. */
    note: z.string().max(2000).nullable().optional(),
  }),
});

export const contentPublished = eventType("content/published", {
  schema: z.object({
    contentItemId: z.guid(),
    versionId: z.guid(),
    siteId: z.guid(),
    orgId: z.guid(),
    path: z.string(),
    canonicalUrl: z.string().url(),
  }),
});

export const contentPipelineFailed = eventType("content/pipeline.failed", {
  schema: z.object({
    opportunityId: z.guid(),
    siteId: z.guid(),
    orgId: z.guid(),
    stage: z.enum(["brief", "brief_gate", "draft", "qa", "draft_gate", "publish"]),
    error: z.string(),
  }),
});

/** A human gate opened; the app UI and Slack both render from this. */
export const approvalRequested = eventType("approval/requested", {
  schema: z.object({
    approvalId: z.guid(),
    kind: z.enum(["brief", "draft"]),
    siteId: z.guid(),
    orgId: z.guid(),
  }),
});

/** Re-derive the opportunity queue for a site from citation gaps. */
export const opportunitiesScanRequested = eventType("content/opportunities.scan.requested", {
  schema: z.object({ siteId: z.guid(), orgId: z.guid() }),
});
