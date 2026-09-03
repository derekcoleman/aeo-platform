import { upsertExternalMetrics, type ExternalMetricInput } from "../store";
import { ConnectorError, type Connector, type ConnectionRef, type ConnectionRow, type ConnectorContext, type SyncInput, type SyncResult } from "../types";
import { normalizeGa4Rows, queryGa4AiReferrals } from "./ga4";
import { GSC_LAG_DAYS, normalizeGscRows, queryGsc } from "./gsc";
import { refreshAccessToken, type GoogleOAuthConfig } from "./oauth";

export * from "./ga4";
export * from "./gsc";
export * from "./oauth";

/**
 * Google connector: Search Console + GA4 behind one refresh token. Site-
 * scoped (metrics are per site), daily incremental with a re-read window,
 * 16-month backfill on connect so trend lines exist on day one.
 */

export interface GoogleConfig {
  gscProperty?: string | null;
  ga4PropertyId?: string | null;
  /** Content prefix to filter pages by; defaults to the site's path_prefix at sync time. */
  pathPrefix?: string | null;
}

export interface GoogleCursor extends Record<string, unknown> {
  /** Last date (inclusive) we consider complete. */
  through: string;
}

export const GOOGLE_BACKFILL_MONTHS = 16;
export const GOOGLE_INCREMENTAL_DAYS = 7;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** The date window a sync should read, given the cursor and kind. */
export function googleWindow(kind: SyncInput["kind"], cursor: GoogleCursor | null, now: Date): { startDate: string; endDate: string } {
  const endDate = isoDate(addDays(now, -GSC_LAG_DAYS));
  if (kind === "backfill" || !cursor?.through) {
    const start = new Date(now);
    start.setUTCMonth(start.getUTCMonth() - GOOGLE_BACKFILL_MONTHS);
    return { startDate: isoDate(start), endDate };
  }
  // Re-read the trailing week: GSC finalises late and GA4 processes for ~48h.
  const start = addDays(new Date(`${cursor.through}T00:00:00Z`), -GOOGLE_INCREMENTAL_DAYS);
  return { startDate: isoDate(start), endDate };
}

export function googleOAuthFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): GoogleOAuthConfig {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new ConnectorError("google", "not_configured", "GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI not set");
  return { clientId, clientSecret, redirectUri, fetchImpl };
}

async function accessTokenFor(conn: ConnectionRef, ctx: ConnectorContext): Promise<string> {
  if (!conn.secret_ref) throw new ConnectorError("google", "no_token", "google connection has no secret_ref");
  const refreshToken = await ctx.secrets.get(conn.secret_ref);
  if (!refreshToken) throw new ConnectorError("google", "no_token", "google refresh token missing from vault");
  const { accessToken } = await refreshAccessToken(googleOAuthFromEnv(ctx.env, ctx.fetchImpl), refreshToken);
  return accessToken;
}

async function sitePathPrefix(conn: ConnectionRow<GoogleConfig>, ctx: ConnectorContext): Promise<string | null> {
  if (conn.config.pathPrefix !== undefined) return conn.config.pathPrefix;
  if (!conn.site_id) return null;
  const [row] = await ctx.sql<{ path_prefix: string }[]>`select path_prefix from app.sites where id = ${conn.site_id}`;
  return row?.path_prefix ?? null;
}

export const googleConnector: Connector<GoogleConfig> = {
  provider: "google",

  async validate(conn, ctx) {
    if (!conn.site_id) throw new ConnectorError("google", "site_required", "google connections are per site");
    if (!conn.config.gscProperty && !conn.config.ga4PropertyId) throw new ConnectorError("google", "nothing_selected", "select a Search Console property or a GA4 property");
    await accessTokenFor(conn, ctx); // proves the refresh token is live
  },

  async sync(input: SyncInput<GoogleConfig>, ctx): Promise<SyncResult> {
    const { connection: conn, kind } = input;
    if (!conn.site_id) throw new ConnectorError("google", "site_required", "google connections are per site");
    if (kind === "webhook" || kind === "upload") return { documentsIngested: 0, metricsIngested: 0, cursor: input.cursor, detail: { skipped: `kind ${kind}` } };

    const cursor = (input.cursor as GoogleCursor | null) ?? null;
    const window = googleWindow(kind, cursor, ctx.now());
    const accessToken = await accessTokenFor(conn, ctx);
    const pathPrefix = await sitePathPrefix(conn, ctx);
    const siteConn = conn as ConnectionRow<GoogleConfig> & { site_id: string };
    const detail: Record<string, unknown> = { window, pathPrefix };
    let metrics = 0;

    if (conn.config.gscProperty) {
      const gsc: ExternalMetricInput[] = [];
      for (const dims of [["date", "query"], ["date", "page"]] as const) {
        const rows = await queryGsc(ctx.fetchImpl, accessToken, { property: conn.config.gscProperty, ...window, dimensions: [...dims], pathPrefix });
        gsc.push(...normalizeGscRows(rows, [...dims], pathPrefix));
      }
      const n = await upsertExternalMetrics(siteConn, gsc, ctx.sql);
      metrics += n;
      detail.gsc = { rows: gsc.length, written: n };
    }

    if (conn.config.ga4PropertyId) {
      const rows = await queryGa4AiReferrals(ctx.fetchImpl, accessToken, { propertyId: conn.config.ga4PropertyId, ...window, pathPrefix });
      const ga4 = normalizeGa4Rows(rows);
      const n = await upsertExternalMetrics(siteConn, ga4, ctx.sql);
      metrics += n;
      detail.ga4 = { rows: ga4.length, written: n };
    }

    return { documentsIngested: 0, metricsIngested: metrics, cursor: { through: window.endDate }, detail };
  },

  async disconnect(conn, ctx) {
    if (!conn.secret_ref) return;
    const refreshToken = await ctx.secrets.get(conn.secret_ref);
    if (!refreshToken) return;
    try {
      await ctx.fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST" });
    } catch {
      // Best effort; the Vault delete is what matters on our side.
    }
  },
};
