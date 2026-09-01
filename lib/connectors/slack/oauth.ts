import { ConnectorError } from "../types";

/**
 * Slack OAuth v2. Bot scopes only, and the narrowest set that supports
 * reading the channels the customer picks plus posting approvals back:
 * no `channels:history` on anything the customer did not select — the
 * scope grants the *ability*; `scope` on the connection row decides *what*.
 */

export const SLACK_BOT_SCOPES = ["channels:read", "channels:history", "groups:read", "groups:history", "chat:write", "users:read"] as const;

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export function slackAuthorizeUrl(cfg: Pick<SlackOAuthConfig, "clientId" | "redirectUri">, state: string, scopes: readonly string[] = SLACK_BOT_SCOPES): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("user_scope", "");
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface SlackTokenGrant {
  botToken: string;
  botUserId: string | null;
  teamId: string;
  teamName: string | null;
  scopes: string[];
}

interface OAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  scope?: string;
  team?: { id?: string; name?: string };
}

export async function exchangeSlackCode(cfg: SlackOAuthConfig, code: string): Promise<SlackTokenGrant> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri });
  const res = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json().catch(() => ({ ok: false, error: "invalid_json" }))) as OAuthAccessResponse;
  if (!res.ok || !data.ok || !data.access_token || !data.team?.id) {
    throw new ConnectorError("slack", "oauth_failed", `slack oauth: ${data.error ?? `HTTP ${res.status}`}`);
  }
  return {
    botToken: data.access_token,
    botUserId: data.bot_user_id ?? null,
    teamId: data.team.id,
    teamName: data.team.name ?? null,
    scopes: (data.scope ?? "").split(",").filter(Boolean),
  };
}
