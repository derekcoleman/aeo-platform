import { googleAuthorizeUrl } from "./google/oauth";
import { googleOAuthFromEnv } from "./google";
import { createOAuthState, type OAuthState } from "./oauth-state";
import { slackAuthorizeUrl } from "./slack/oauth";
import { slackOAuthFromEnv } from "./slack";
import { ConnectorError, type ConnectorProvider } from "./types";

/**
 * Builds the provider consent URL for an authenticated caller. There is
 * deliberately no HTTP route for this yet: without a session to prove the
 * caller belongs to `orgId`, a start route would let anyone mint signed state
 * for any org. The auth layer calls this once it exists; the callbacks below
 * `app/(app)/api/connectors/*` already trust only the signed state.
 */
export type OAuthStartInput = Pick<OAuthState, "orgId" | "siteId" | "userId" | "returnTo">;

export function authorizeUrlFor(provider: Exclude<ConnectorProvider, "profound">, input: OAuthStartInput, env: NodeJS.ProcessEnv, now: Date = new Date()): string {
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
