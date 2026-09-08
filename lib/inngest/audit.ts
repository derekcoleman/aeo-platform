import { executeAuditRun } from "@/lib/audit/execute";
import { markAuditFailed } from "@/lib/audit/store";
import { auditCompleted, auditFailed, auditRequested, inngest } from "./client";

/**
 * The audit job. gtm-agents ran 50 pages × (fetch + sequential model call)
 * inline in a serverless route with no maxDuration; medium sites timed out.
 * Here the route enqueues and polls; the work runs as a durable step with
 * per-org concurrency so one tenant's monitored re-runs can't starve the
 * public lead magnet.
 */
export const auditFunction = inngest.createFunction(
  {
    id: "audit-run",
    triggers: [auditRequested],
    concurrency: [{ key: "event.data.orgId", limit: 2 }, { limit: 10 }],
    retries: 1,
    onFailure: async ({ event, error }) => {
      const data = event.data.event.data;
      await markAuditFailed(data.auditRunId, error.message);
      await inngest.send(auditFailed.create({ auditRunId: data.auditRunId, error: error.message, orgId: data.orgId }));
    },
  },
  async ({ event, step }) => {
    const { auditRunId, targetUrl, kind, orgId, siteId, contentPrefix } = event.data;

    // One step: the audit is not itself step-shaped (page fetches feed model
    // calls feed scoring), and its result is far too large to memoize per
    // page. If this outgrows a single step's budget, split at fetch/score.
    // The body lives in lib/audit/execute.ts so the no-Inngest fallback runs
    // the identical code.
    const summary = await step.run("run-audit", () => executeAuditRun({ auditRunId, targetUrl, kind, contentPrefix }));

    if (summary.ok) {
      await step.sendEvent("notify", auditCompleted.create({ auditRunId, domain: summary.domain, geoScore: summary.geoScore, orgId, siteId }));
    }
    return summary;
  },
);
