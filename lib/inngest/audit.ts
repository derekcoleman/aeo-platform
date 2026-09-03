import { runAudit, AuditError } from "@/lib/audit";
import { completeAuditRun, markAuditFailed, markAuditRunning } from "@/lib/audit/store";
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

    await step.run("mark-running", () => markAuditRunning(auditRunId));

    // One step: the audit is not itself step-shaped (page fetches feed model
    // calls feed scoring), and its result is far too large to memoize per
    // page. If this outgrows a single step's budget, split at fetch/score.
    const summary = await step.run("run-audit", async () => {
      try {
        const run = await runAudit(targetUrl, {
          maxPages: kind === "public" ? 12 : 24,
          contentPrefix: contentPrefix ?? undefined,
        });
        await completeAuditRun(auditRunId, run);
        return { ok: true as const, domain: run.result.domain, geoScore: run.result.geoScore, degraded: run.result.degraded.length };
      } catch (e) {
        // Unreachable/blocked targets are terminal, not retryable.
        if (e instanceof AuditError) {
          await markAuditFailed(auditRunId, `${e.code}: ${e.message}`);
          return { ok: false as const, error: e.message };
        }
        throw e;
      }
    });

    if (summary.ok) {
      await step.sendEvent("notify", auditCompleted.create({ auditRunId, domain: summary.domain, geoScore: summary.geoScore, orgId, siteId }));
    }
    return summary;
  },
);
