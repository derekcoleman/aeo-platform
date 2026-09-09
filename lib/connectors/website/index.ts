import { crawlSite, type CrawledPage } from "@/lib/crawl/site";
import type { DocumentInput } from "@/lib/connectors/store";
import { upsertDocuments } from "@/lib/connectors/store";
import type { Connector, ConnectionRow, ConnectorContext, SyncResult } from "@/lib/connectors/types";

/**
 * The customer's own website as a brand-brain source. Created automatically
 * at project creation (no secret, no OAuth) and re-synced on the daily
 * connector schedule, so a redesign or a new pricing page shows up in the
 * brain without anyone re-running onboarding.
 */
export interface WebsiteConfig {
  origin: string;
  maxPages?: number;
}

export function pagesToDocuments(pages: CrawledPage[], siteId: string | null): DocumentInput[] {
  return pages.map((p) => ({
    kind: "web_page",
    externalId: p.url,
    title: p.title || p.path,
    text: p.markdown,
    siteId,
    metadata: { path: p.path, pageKind: p.kind, status: p.status },
    sourceTs: new Date(),
  }));
}

export async function crawlConnection(conn: ConnectionRow<WebsiteConfig>, ctx: ConnectorContext): Promise<{ pages: CrawledPage[]; written: number }> {
  const { pages } = await crawlSite(conn.config.origin, {
    maxPages: conn.config.maxPages ?? 20,
    fetch: { fetchImpl: ctx.fetchImpl, allowPrivate: ctx.env.AEO_FETCH_ALLOW_PRIVATE === "1" },
  });
  const written = await upsertDocuments(conn, pagesToDocuments(pages, conn.site_id), { retentionDays: null }, ctx.sql);
  return { pages, written };
}

export const websiteConnector: Connector<WebsiteConfig> = {
  provider: "website",
  async validate(conn) {
    new URL(conn.config.origin);
  },
  async sync(input, ctx): Promise<SyncResult> {
    const { pages, written } = await crawlConnection(input.connection, ctx);
    return { documentsIngested: written, metricsIngested: 0, cursor: { crawledAt: ctx.now().toISOString(), pages: pages.length }, detail: { pages: pages.length, kinds: pages.map((p) => p.kind) } };
  },
};
