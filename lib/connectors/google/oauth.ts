import { parseRetryAfter, RetryableError, withRetry } from "@/lib/fetch/retry";
import { ConnectorError } from "../types";

/**
 * Google OAuth for Search Console + GA4 in one consent. Read-only scopes,
 * offline access so we hold a refresh token (the thing that goes to Vault),
 * and `prompt=consent` because Google only returns a refresh token on the
 * first grant unless asked.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export function googleAuthorizeUrl(cfg: Pick<GoogleOAuthConfig, "clientId" | "redirectUri">, state: string, scopes: readonly string[] = GOOGLE_SCOPES): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface GoogleTokenGrant {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  /** Email of the granting account when the id_token carries it. */
  email: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(cfg: GoogleOAuthConfig, params: Record<string, string>): Promise<TokenResponse> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return withRetry(async () => {
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`google token ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
    const data = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || data.error) {
      const code = data.error === "invalid_grant" ? "auth" : "oauth_failed";
      throw new ConnectorError("google", code, `google oauth: ${data.error ?? `HTTP ${res.status}`}${data.error_description ? ` (${data.error_description})` : ""}`);
    }
    return data;
  }, { maxRetries: 2 });
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(cfg: GoogleOAuthConfig, code: string): Promise<GoogleTokenGrant> {
  const data = await tokenRequest(cfg, { code, grant_type: "authorization_code", redirect_uri: cfg.redirectUri });
  if (!data.refresh_token || !data.access_token) {
    throw new ConnectorError("google", "no_refresh_token", "google oauth returned no refresh token; the grant must be re-consented");
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
    email: emailFromIdToken(data.id_token),
  };
}

export async function refreshAccessToken(cfg: GoogleOAuthConfig, refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  const data = await tokenRequest(cfg, { refresh_token: refreshToken, grant_type: "refresh_token" });
  if (!data.access_token) throw new ConnectorError("google", "oauth_failed", "google refresh returned no access token");
  return { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

/** Authenticated JSON call against a Google API with 429/5xx retry and auth-error classification. */
export async function googleJson<T>(fetchImpl: typeof fetch, accessToken: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  return withRetry(async () => {
    const res = await fetchImpl(url, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`google ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
    if (res.status === 401 || res.status === 403) throw new ConnectorError("google", "auth", `google ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    if (!res.ok) throw new ConnectorError("google", "http_error", `google ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return (await res.json()) as T;
  }, { maxRetries: 3 });
}
