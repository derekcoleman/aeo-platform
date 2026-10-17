import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { googleAuthorizeUrl } from "./google/oauth";
import { googleOAuthFromEnv } from "./google";
import { createOAuthState, type OAuthState } from "./oauth-state";
import { slackAuthorizeUrl } from "./slack/oauth";
import { slackOAuthFromEnv } from "./slack";
import { ConnectorError, type ConnectorProvider } from "./types";

/**
 * Builds the provider consent URL for an authenticated caller. The start
 * route (`app/(app)/api/connectors/[provider]/start`) proves the caller
 * manages `orgId` and that `siteId` is one of that org's sites before calling
 * this: the callbacks below `app/(app)/api/connectors/*` trust only the signed
 * state, so whatever goes into it is what the connection is bound to.
 */
export type OAuthStartInput = Pick<OAuthState, "orgId" | "siteId" | "userId" | "returnTo">;

export function authorizeUrlFor(provider: Extract<ConnectorProvider, "slack" | "google">, input: OAuthStartInput, env: NodeJS.ProcessEnv, now: Date = new Date()): string {
  const secret = env.OAUTH_STATE_SECRET ?? "";
  const state = createOAuthState(secret, { ...input, provider }, now);
  switch (provider) {
    case "google":
      return googleAuthorizeUrl(googleOAuthFromEnv(env), state);
    case "slack":
      return slackAuthorizeUrl(slackOAuthFromEnv(env), state);
    default:
      throw new ConnectorError(provider, "no_oauth", `${provider} does not use OAuth`);
  }
}

/** The site named in an OAuth start is missing or belongs to another organisation. */
export class SiteNotInOrgError extends Error {
  constructor(siteId: string) {
    super(`site ${siteId} is not a project of this organisation`);
    this.name = "SiteNotInOrgError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws SiteNotInOrgError unless `siteId` is a site of `orgId`. Managing one
 * org is not a licence to bind a grant to another org's project: the signed
 * state would carry that site, and the Google sync would write the grant's
 * Search Console data under it. The context_connections trigger (0018) is
 * the backstop for any writer that skips this.
 */
export async function assertSiteInOrg(siteId: string, orgId: string, sql: postgres.Sql = appDb()): Promise<void> {
  if (!UUID.test(siteId) || !UUID.test(orgId)) throw new SiteNotInOrgError(siteId);
  const [row] = await sql<{ id: string }[]>`select id from app.sites where id = ${siteId} and org_id = ${orgId}`;
  if (!row) throw new SiteNotInOrgError(siteId);
}
