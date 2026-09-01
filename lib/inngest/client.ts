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
