import type postgres from "postgres";
import { connectorContext } from "@/lib/connectors";
import { CONNECTOR_CATALOG, connectionsFor, connectorState, type ConnectorDef, type ConnectorState } from "@/lib/connectors/catalog";
import { listGa4Properties, listGscProperties, refreshAccessToken, googleOAuthFromEnv } from "@/lib/connectors/google";
import { listSlackChannels, slackClientFor, slackTokenFor, type SlackChannel } from "@/lib/connectors/slack";
import { latestSyncRun, type SyncRunRow } from "@/lib/connectors/store";
import { describeSyncState, type SyncState } from "@/lib/connectors/sync-status";
import type { ConnectionRow, ConnectorContext } from "@/lib/connectors/types";
import { appDb } from "@/lib/db/app";
import { listConnectionsForOrg } from "./queries";
import { listSites, type SiteRow } from "./store";

/**
 * Read model for the Connectors page: the catalogue joined with the org's
 * live rows, plus the option lists a half-configured connection needs (the
 * Google properties a grant can see, the Slack channels the bot can see).
 * Lookups hit the provider; a failure is a message on the card, never a
 * thrown page.
 */

export interface ConnectionView {
  row: ConnectionRow;
  site: SiteRow | null;
  state: ConnectorState;
  sync: SyncState;
  latestRun: SyncRunRow | null;
}

export interface CatalogEntryView {
  def: ConnectorDef;
  connections: ConnectionView[];
  /** The worst state across the entry's rows, or not_connected. */
  state: ConnectorState;
}

export interface GoogleOptions {
  gsc: { siteUrl: string; permissionLevel: string }[];
  ga4: { propertyId: string; displayName: string }[];
  error: string | null;
}

export interface SlackOptions {
  channels: SlackChannel[];
  error: string | null;
}

export interface ConnectorsOverview {
  sites: SiteRow[];
  entries: CatalogEntryView[];
  /** Per Google connection id. */
  google: Map<string, GoogleOptions>;
  /** Per Slack connection id. */
  slack: Map<string, SlackOptions>;
  /** Which OAuth providers this deployment has client credentials for. */
  oauthReady: { google: boolean; slack: boolean };
}

const RANK: Record<ConnectorState, number> = { error: 0, needs_setup: 1, connected: 2, not_connected: 3 };

export async function connectorsOverview(orgId: string, opts: { sql?: postgres.Sql; ctx?: ConnectorContext; env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<ConnectorsOverview> {
  const sql = opts.sql ?? appDb();
  const ctx = opts.ctx ?? connectorContext({ sql });
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const [sites, rows] = await Promise.all([listSites([orgId], sql), listConnectionsForOrg(orgId, sql)]);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const runs = new Map<string, SyncRunRow | null>();
  await Promise.all(rows.map(async (r) => runs.set(r.id, await latestSyncRun(r.id, sql))));

  const view = (def: ConnectorDef, row: ConnectionRow): ConnectionView => {
    const latestRun = runs.get(row.id) ?? null;
    return { row, site: row.site_id ? (siteById.get(row.site_id) ?? null) : null, state: connectorState(def, row), latestRun, sync: describeSyncState({ now, requestedAt: row.sync_requested_at, requestedKind: row.sync_requested_kind, latestRun }) };
  };
  const entries = CONNECTOR_CATALOG.map((def) => {
    const connections = connectionsFor(def, rows).map((r) => view(def, r));
    const state = connections.length ? connections.map((c) => c.state).sort((a, b) => RANK[a] - RANK[b])[0]! : "not_connected";
    return { def, connections, state };
  });

  const google = new Map<string, GoogleOptions>();
  for (const r of rows.filter((r) => r.provider === "google" && r.status !== "disconnected")) google.set(r.id, await googleOptionsFor(r, ctx));
  const slack = new Map<string, SlackOptions>();
  for (const r of rows.filter((r) => r.provider === "slack" && r.status !== "disconnected")) slack.set(r.id, await slackOptionsFor(r, ctx));

  return {
    sites,
    entries,
    google,
    slack,
    oauthReady: {
      google: !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI),
      slack: !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_REDIRECT_URI),
    },
  };
}

/** The Search Console properties and GA4 properties a Google grant can read. */
export async function googleOptionsFor(conn: ConnectionRow, ctx: ConnectorContext): Promise<GoogleOptions> {
  try {
    if (!conn.secret_ref) return { gsc: [], ga4: [], error: "no refresh token stored" };
    const refreshToken = await ctx.secrets.get(conn.secret_ref);
    if (!refreshToken) return { gsc: [], ga4: [], error: "refresh token missing from Vault" };
    const { accessToken } = await refreshAccessToken(googleOAuthFromEnv(ctx.env, ctx.fetchImpl), refreshToken);
    const [gsc, ga4] = await Promise.all([
      listGscProperties(ctx.fetchImpl, accessToken).catch((e: unknown) => {
        throw new Error(`Search Console: ${e instanceof Error ? e.message : String(e)}`);
      }),
      listGa4Properties(ctx.fetchImpl, accessToken).catch(() => [] as { propertyId: string; displayName: string }[]),
    ]);
    return { gsc, ga4, error: null };
  } catch (e) {
    return { gsc: [], ga4: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** The channels the Slack bot can see, for the picker. */
export async function slackOptionsFor(conn: ConnectionRow, ctx: ConnectorContext): Promise<SlackOptions> {
  try {
    const token = await slackTokenFor(conn, ctx);
    const channels = await listSlackChannels(slackClientFor(conn, token, ctx));
    return { channels: channels.filter((c) => !c.is_archived).sort((a, b) => a.name.localeCompare(b.name)), error: null };
  } catch (e) {
    return { channels: [], error: e instanceof Error ? e.message : String(e) };
  }
}
