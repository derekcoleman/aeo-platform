import type postgres from "postgres";
import { llmConfigured, LLM_NOT_CONFIGURED } from "@/lib/ai/model";
import { loadSite } from "@/lib/app/store";
import { connectorContext, createConnection, listConnections, withSyncRun, type ConnectionRow, type ConnectorContext } from "@/lib/connectors";
import { crawlConnection, type WebsiteConfig } from "@/lib/connectors/website";
import { appDb } from "@/lib/db/app";
import { contextIngestRequested, demandMineRequested, inngest } from "@/lib/inngest/client";
import { inngestConfigured } from "@/lib/jobs/runner";
import { modelFor } from "@/lib/pipeline/model";
import { applyBusinessProfile, extractBusinessProfile } from "./profile";

/**
 * Onboarding for one project, in order:
 *   1. ensure the site's `website` connection exists,
 *   2. crawl it into context.context_documents (a sync run, like any source),
 *   3. extract the business profile and seed entities from it,
 *   4. hand the documents to the brain (chunks, embeddings, facts) and, when a
 *      SERP provider is configured, start mining demand from the keywords.
 * Runs as an Inngest function when Inngest is connected, in-process after
 * the response otherwise, so a fresh deployment still onboards a project.
 */
export interface OnboardingSummary {
  siteId: string;
  pages: number;
  documents: number;
  profile: "ready" | "skipped";
  mining: boolean;
}

export async function ensureWebsiteConnection(site: { id: string; org_id: string; canonical_domain: string }, ctx: ConnectorContext): Promise<ConnectionRow<WebsiteConfig>> {
  const existing = (await listConnections({ orgId: site.org_id, provider: "website" }, ctx.sql)).find((c) => c.site_id === site.id && c.status !== "disconnected");
  if (existing) return existing as unknown as ConnectionRow<WebsiteConfig>;
  const created = await createConnection(
    { orgId: site.org_id, siteId: site.id, provider: "website", status: "active", config: { origin: `https://${site.canonical_domain}`, maxPages: 20 }, externalAccountId: site.canonical_domain, externalAccountName: site.canonical_domain },
    ctx.secrets,
    ctx.sql,
  );
  return created as unknown as ConnectionRow<WebsiteConfig>;
}

export async function setProfileStatus(siteId: string, status: "queued" | "running" | "ready" | "failed", error: string | null = null, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update app.sites set profile_status = ${status}, profile_error = ${error}, profile_updated_at = now() where id = ${siteId}`;
}

export async function runSiteOnboarding(input: { siteId: string; orgId: string }, deps: { ctx?: ConnectorContext; sql?: postgres.Sql } = {}): Promise<OnboardingSummary> {
  const sql = deps.sql ?? appDb();
  const ctx = deps.ctx ?? connectorContext({ sql });
  const site = await loadSite(input.siteId, sql);
  if (!site || site.org_id !== input.orgId) throw new Error(`site ${input.siteId} not found in org ${input.orgId}`);
  await setProfileStatus(site.id, "running", null, sql);
  try {
    const conn = await ensureWebsiteConnection(site, ctx);
    const { pages, written } = await withSyncRun(conn, "backfill", async () => {
      const r = await crawlConnection(conn, ctx);
      return { ...r, documentsIngested: r.written, metricsIngested: 0, cursor: { crawledAt: ctx.now().toISOString(), pages: r.pages.length } };
    }, sql);

    let profile: OnboardingSummary["profile"] = "skipped";
    if (llmConfigured(ctx.env)) {
      const { profile: extracted } = await extractBusinessProfile(modelFor("site.profile.extract", ctx.env), pages, { domain: site.canonical_domain, name: site.name }, { orgId: site.org_id, siteId: site.id }, sql);
      await applyBusinessProfile(site, extracted, sql);
      profile = "ready";
    } else {
      await sql`update app.sites set profile_status = 'ready', profile_error = ${`Crawled ${pages.length} pages. ${LLM_NOT_CONFIGURED} Add one and re-crawl to extract the business profile.`}, profile_updated_at = now() where id = ${site.id}`;
    }

    let mining = false;
    if (inngestConfigured(ctx.env)) {
      const events: Parameters<typeof inngest.send>[0][] = [];
      if (written > 0) events.push(contextIngestRequested.create({ orgId: site.org_id, connectionId: conn.id }));
      const serp = !!(ctx.env.DATAFORSEO_LOGIN || ctx.env.SERPAPI_KEY);
      if (serp && site.keywords.length > 0) {
        const [country = "us", language = "en"] = (site.locale || "en-US").split("-").reverse().map((s) => s.toLowerCase());
        events.push(demandMineRequested.create({ siteId: site.id, orgId: site.org_id, seeds: site.keywords.slice(0, 50), locale: { country: country.slice(0, 2), language: language.slice(0, 2) }, depth: 1, trackTop: 50, paa: true }));
        mining = true;
      }
      for (const e of events) await inngest.send(e).catch((err) => console.warn(`[onboarding] follow-up event failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { siteId: site.id, pages: pages.length, documents: written, profile, mining };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setProfileStatus(site.id, "failed", message.slice(0, 500), sql).catch(() => undefined);
    throw e;
  }
}
