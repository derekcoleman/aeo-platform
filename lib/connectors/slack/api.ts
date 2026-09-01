import { parseRetryAfter, RetryableError, withRetry } from "@/lib/fetch/retry";
import { ConnectorError } from "../types";

/**
 * Minimal Slack Web API client over fetch. No SDK: the surface we use is
 * five methods, and the SDK's own retry/backoff would fight `withRetry`.
 */

const BASE = "https://slack.com/api";

export interface SlackApiOptions {
  token: string;
  fetchImpl?: typeof fetch;
  /** Overall attempts on 429 / 5xx. */
  maxRetries?: number;
}

export interface SlackResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { next_cursor?: string };
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  /** Set by Slack on the parent of a thread. */
  latest_reply?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
}

export interface SlackApi {
  call<T extends SlackResponse>(method: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  /** Walk `response_metadata.next_cursor` and concatenate `pick(page)`. */
  paginate<T extends SlackResponse, R>(method: string, params: Record<string, string | number | boolean | undefined>, pick: (page: T) => R[], maxPages?: number): Promise<R[]>;
}

/** Slack errors that will not clear on retry and mean the connection needs attention. */
export const SLACK_AUTH_ERRORS = new Set(["invalid_auth", "account_inactive", "token_revoked", "token_expired", "not_authed", "missing_scope"]);

export function slackApi(opts: SlackApiOptions): SlackApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;

  async function call<T extends SlackResponse>(method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    return withRetry(async () => {
      const res = await fetchImpl(`${BASE}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`slack ${method} ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
      }
      if (!res.ok) throw new ConnectorError("slack", "http_error", `slack ${method}: HTTP ${res.status}`);
      const data = (await res.json()) as T;
      if (!data.ok) {
        const code = data.error ?? "unknown_error";
        if (code === "ratelimited") throw new RetryableError(`slack ${method} ratelimited`, 1000);
        throw new ConnectorError("slack", SLACK_AUTH_ERRORS.has(code) ? "auth" : code, `slack ${method}: ${code}`);
      }
      return data;
    }, { maxRetries });
  }

  async function paginate<T extends SlackResponse, R>(
    method: string,
    params: Record<string, string | number | boolean | undefined>,
    pick: (page: T) => R[],
    maxPages = 50,
  ): Promise<R[]> {
    const out: R[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await call<T>(method, { ...params, cursor });
      out.push(...pick(page));
      cursor = page.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  return { call, paginate };
}
