import { lookup } from "node:dns/promises";
import { checkSsrf, isBlockedIpv4, isBlockedIpv6 } from "./ssrf";
import { RetryableError, parseRetryAfter, withRetry } from "./retry";

/**
 * The one outbound fetch used for anything a user pointed us at.
 *
 * - SSRF-checked on the literal URL, then again on the resolved address so
 *   a hostname that resolves to 10.0.0.1 is refused (DNS rebinding).
 * - Redirects are followed manually so every hop is checked, capped at 5.
 * - Body size is capped; a 200MB "page" is a denial-of-service, not a page.
 * - 429/503 and network errors are retried with backoff; other statuses are
 *   returned as data because the audit *wants* to see a 403 from a WAF.
 */

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  /** Test hook: bypass DNS resolution (fixtures run on loopback). */
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Headers;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: string[];
  durationMs: number;
}

export class FetchBlockedError extends Error {
  constructor(
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = "FetchBlockedError";
  }
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; AEOAuditBot/1.0; +https://aeo.app/audit-bot)";

async function assertResolvesPublic(url: URL, allowPrivate: boolean): Promise<void> {
  const verdict = checkSsrf(url);
  if (!verdict.safe) throw new FetchBlockedError(verdict.reason ?? "blocked", url.href);
  if (allowPrivate) return;
  const host = url.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return; // literal, already checked
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new FetchBlockedError(`could not resolve ${host}`, url.href);
  }
  for (const { address, family } of addresses) {
    const blocked = family === 6 ? isBlockedIpv6(address) : isBlockedIpv4(address);
    if (blocked) throw new FetchBlockedError(`${host} resolves to a private address`, url.href);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, Math.min(c.byteLength, maxBytes - offset)));
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= maxBytes) break;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

export async function safeFetch(input: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const {
    timeoutMs = 15_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 5,
    maxRetries = 2,
    headers = {},
    userAgent = DEFAULT_USER_AGENT,
    allowPrivate = process.env.AEO_FETCH_ALLOW_PRIVATE === "1",
    fetchImpl = fetch,
  } = opts;

  const started = Date.now();
  const redirects: string[] = [];

  return withRetry(
    async () => {
      let current = new URL(input);
      for (let hop = 0; ; hop++) {
        await assertResolvesPublic(current, allowPrivate);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res: Response;
        try {
          res = await fetchImpl(current.href, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "user-agent": userAgent,
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
              "accept-language": "en-US,en;q=0.9",
              ...headers,
            },
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) break;
          if (hop >= maxRedirects) throw new FetchBlockedError("too many redirects", current.href);
          await res.body?.cancel().catch(() => undefined);
          const next = new URL(loc, current);
          redirects.push(next.href);
          current = next;
          continue;
        }

        if (res.status === 429 || res.status === 503) {
          await res.body?.cancel().catch(() => undefined);
          throw new RetryableError(`upstream ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
        }

        const { text, truncated } = await readCapped(res, maxBytes);
        return {
          url: input,
          finalUrl: current.href,
          status: res.status,
          ok: res.ok,
          headers: res.headers,
          contentType: res.headers.get("content-type") ?? "",
          body: text,
          truncated,
          redirects,
          durationMs: Date.now() - started,
        };
      }
      throw new FetchBlockedError("redirect without location", current.href);
    },
    {
      maxRetries,
      baseDelayMs: 1500,
      shouldRetry: (err) => !(err instanceof FetchBlockedError) && (err instanceof RetryableError || isNetworkError(err)),
    },
  );
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  return !!code && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
}

/** Run `fn` over `items` with at most `limit` in flight. Order preserved. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
