import { Inngest, eventType } from "inngest";
import { z } from "zod";

/**
 * Typed event catalogue. Every event that crosses a job boundary is declared
 * here (with a runtime schema) so a producer and consumer cannot disagree on
 * shape. Send with `inngest.send(evt.create(data))`.
 */
export const auditRequested = eventType("audit/requested", {
  schema: z.object({
    auditRunId: z.string().uuid(),
    targetUrl: z.string().url(),
    kind: z.enum(["public", "preflight", "monitored"]),
    orgId: z.string().uuid().nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
    contentPrefix: z.string().nullable().optional(),
  }),
});

export const auditCompleted = eventType("audit/completed", {
  schema: z.object({
    auditRunId: z.string().uuid(),
    domain: z.string(),
    geoScore: z.number(),
    orgId: z.string().uuid().nullable().optional(),
    siteId: z.string().uuid().nullable().optional(),
  }),
});

export const auditFailed = eventType("audit/failed", {
  schema: z.object({
    auditRunId: z.string().uuid(),
    error: z.string(),
    orgId: z.string().uuid().nullable().optional(),
  }),
});

export const inngest = new Inngest({ id: "aeo-platform" });

const localeSchema = z.object({ country: z.string().length(2), language: z.string().min(2).max(5) });

/** Mine a question graph for a site from a seed list (brand-brain terms, competitors, ICP pains). */
export const demandMineRequested = eventType("demand/mine.requested", {
  schema: z.object({
    siteId: z.string().uuid(),
    orgId: z.string().uuid(),
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
    siteId: z.string().uuid(),
    orgId: z.string().uuid(),
    inserted: z.number(),
    updated: z.number(),
    queriesIssued: z.number(),
    costUsd: z.number(),
  }),
});

/** Snapshot the SERP (AI Overview, featured snippet, organic, PAA) for a set of questions. */
export const serpTrackRequested = eventType("serp/track.requested", {
  schema: z.object({
    siteId: z.string().uuid(),
    orgId: z.string().uuid(),
    questionIds: z.array(z.string().uuid()).min(1).max(200),
  }),
});

export const serpTrackCompleted = eventType("serp/track.completed", {
  schema: z.object({
    siteId: z.string().uuid(),
    orgId: z.string().uuid(),
    snapshots: z.number(),
    aioTriggered: z.number(),
    ownedCitations: z.number(),
    costUsd: z.number(),
  }),
});
