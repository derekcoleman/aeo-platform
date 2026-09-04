import { connectorContext } from "@/lib/connectors";
import { appDb } from "@/lib/db/app";
import { notifyHealthEmail, notifyHealthSlack } from "@/lib/proxy/alerts";
import { probeCrawlerAccess } from "@/lib/proxy/crawler-access";
import { publicOrigin, runHealthCheck } from "@/lib/proxy/health";
import { runPreflight } from "@/lib/proxy/preflight";
import {
  completePreflight,
  createPreflight,
  failPreflight,
  latestPublishedPath,
  listSitesForHealth,
  loadSiteOps,
  markPreflightRunning,
  markSiteVerified,
  markSiteVerifying,
  recordHealthCheck,
  toHealthSite,
} from "@/lib/proxy/store";
import { inngest, siteHealthChanged, siteHealthCheckRequested, sitePreflightCompleted, sitePreflightRequested, siteVerified } from "./client";

/**
 * Proxy onboarding and health. The monitor fans out every five minutes to
 * every active or verifying site; each check runs through the customer's
 * edge, lands a row, and alerts only on a transition. Verification is the
 * same check with a different consequence: a pass flips the site active.
 */

function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_URL ?? "https://app.aeo.app").replace(/\/$/, "");
}

export const siteHealthCheckFunction = inngest.createFunction(
  {
    id: "site-health-check",
    triggers: [siteHealthCheckRequested],
    concurrency: [{ key: "event.data.siteId", limit: 1 }, { limit: 20 }],
    retries: 1,
  },
  async ({ event, step }) => {
    const { siteId, orgId, kind } = event.data;
    const site = await step.run("load", () => loadSiteOps(siteId));
    if (!site || site.org_id !== orgId) return { skipped: "site not found" as const };
    if (site.status === "paused" || site.status === "disabled") return { skipped: `site ${site.status}` as const };

    const outcome = await step.run("check", async () => {
      const sql = appDb();
      const articlePath = await latestPublishedPath(siteId, sql);
      const result = await runHealthCheck(toHealthSite(site), { articlePath, expectIndexable: site.status === "active" });
      const transition = await recordHealthCheck(site, kind, result, sql);
      return { result, transition };
    });

    const { result, transition } = outcome;
    if (transition.alertFailure || transition.alertRecovery) {
      await step.run("alert", async () => {
        const notice = { site: { id: site.id, name: site.name, canonicalDomain: site.canonical_domain, pathPrefix: site.path_prefix }, ok: result.ok, failures: transition.failures, result, appUrl: appUrl() };
        let slack: { posted: boolean } = { posted: false };
        try {
          slack = await notifyHealthSlack(orgId, notice, connectorContext());
        } catch (e) {
          // Slack is best effort; the banner and the row are the record.
          console.warn(`[site-health] slack alert failed for ${siteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
        let email: { sent: boolean } = { sent: false };
        try {
          email = await notifyHealthEmail(orgId, notice);
        } catch (e) {
          console.warn(`[site-health] email alert failed for ${siteId}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return { slack: slack.posted, email: email.sent };
      });
    }
    if (transition.previousOk !== result.ok) {
      await step.sendEvent("changed", siteHealthChanged.create({ siteId, orgId, ok: result.ok, failures: transition.failures, failed: result.failed }));
    }
    if (kind === "verification" && result.ok && (site.status === "provisioning" || site.status === "verifying")) {
      await step.run("activate", () => markSiteVerified(siteId, orgId));
      await step.sendEvent("verified", siteVerified.create({ siteId, orgId }));
    }
    return { ok: result.ok, failed: result.failed, warnings: result.warnings, failures: transition.failures, ttfbMs: result.ttfbMs };
  },
);

/** Every five minutes, every live or verifying site. Two failures in a row → alert; recovery → alert. */
export const siteHealthMonitor = inngest.createFunction(
  { id: "site-health-monitor", triggers: [{ cron: "*/5 * * * *" }], retries: 0 },
  async ({ step }) => {
    const sites = await step.run("list-sites", () => listSitesForHealth());
    if (sites.length === 0) return { sites: 0 };
    await step.sendEvent("fan-out", sites.map((s) => siteHealthCheckRequested.create({ siteId: s.id, orgId: s.org_id, kind: "monitor" })));
    return { sites: sites.length };
  },
);

export const sitePreflightFunction = inngest.createFunction(
  {
    id: "site-preflight",
    triggers: [sitePreflightRequested],
    concurrency: [{ key: "event.data.siteId", limit: 1 }, { limit: 5 }],
    retries: 1,
  },
  async ({ event, step }) => {
    const { siteId, orgId, kind } = event.data;
    const site = await step.run("load", () => loadSiteOps(siteId));
    if (!site || site.org_id !== orgId) return { skipped: "site not found" as const };

    const preflightId = await step.run("open", async () => {
      const id = event.data.preflightId ?? (await createPreflight(siteId, kind)).id;
      await markPreflightRunning(id);
      return id;
    });

    try {
      if (kind === "crawler_report") {
        const report = await step.run("crawler-report", async () => {
          const sql = appDb();
          const articlePath = await latestPublishedPath(siteId, sql);
          const target = `${publicOrigin(toHealthSite(site))}${articlePath ?? `${site.path_prefix}/aeo-health`}`;
          const r = await probeCrawlerAccess(target);
          await completePreflight(preflightId, { ok: r.summary.tier1Blocked.length === 0, result: { url: target, summary: r.summary }, crawlerAccess: r }, sql);
          return r;
        });
        const ok = report.summary.tier1Blocked.length === 0;
        await step.sendEvent("completed", sitePreflightCompleted.create({ siteId, orgId, preflightId, kind, ok, blocking: report.summary.tier1Blocked.map((b) => `${b} is blocked at their edge or by robots.txt`) }));
        return { preflightId, ok, score: report.summary.score, tier1Blocked: report.summary.tier1Blocked };
      }

      const outcome = await step.run("preflight", async () => {
        const sql = appDb();
        const articlePath = await latestPublishedPath(siteId, sql);
        const r = await runPreflight(toHealthSite(site), { articlePath });
        const { crawlerAccess, ...rest } = r;
        await completePreflight(preflightId, { ok: r.ok, result: rest, crawlerAccess }, sql);
        if (r.ok) await recordHealthCheck(site, "verification", r.health, sql);
        return { ok: r.ok, blocking: r.blocking, installed: r.installed, score: crawlerAccess?.summary.score ?? null };
      });
      if (outcome.ok && (site.status === "provisioning" || site.status === "verifying")) {
        await step.run("activate", () => markSiteVerified(siteId, orgId));
        await step.sendEvent("verified", siteVerified.create({ siteId, orgId }));
      } else if (!outcome.ok && site.status === "provisioning" && outcome.installed) {
        await step.run("verifying", () => markSiteVerifying(siteId, orgId));
      }
      await step.sendEvent("completed", sitePreflightCompleted.create({ siteId, orgId, preflightId, kind, ok: outcome.ok, blocking: outcome.blocking }));
      return { preflightId, ...outcome };
    } catch (e) {
      await step.run("fail", () => failPreflight(preflightId, e instanceof Error ? e.message : String(e)));
      throw e;
    }
  },
);

export const siteFunctions = [siteHealthCheckFunction, siteHealthMonitor, sitePreflightFunction];
