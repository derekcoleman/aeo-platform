/** Exponential backoff with decorrelated jitter and Retry-After awareness. */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    const code = (error as { code?: string }).code;
    if (code && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code)) {
      return true;
    }
  }
  return false;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

export function backoffDelay(attempt: number, base: number, max: number, jitter: number, rand = Math.random): number {
  const exp = Math.min(max, base * 2 ** attempt);
  const spread = exp * jitter;
  return Math.round(Math.min(max, exp - spread + rand() * spread * 2));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    jitter = 0.3,
    shouldRetry = isRetryable,
    onRetry,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error, attempt)) throw error;
      const hinted = error instanceof RetryableError ? error.retryAfterMs : undefined;
      const delay = hinted !== undefined ? Math.min(hinted, maxDelayMs) : backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      onRetry?.(error, attempt, delay);
      await sleep(delay);
      attempt += 1;
    }
  }
}
