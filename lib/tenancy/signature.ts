/**
 * HMAC signatures shared with the customer's Worker. WebCrypto only, because
 * the verifying side is the middleware (edge runtime) as well as Node routes.
 *
 * Two shapes:
 *  - a proxied request signs `${publicHost}${pathname}${minute}` — minute
 *    granularity so a captured signature is not replayable for long, with a
 *    one-minute tolerance either side for clock skew;
 *  - a telemetry post signs its raw JSON body.
 */

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

/** Constant-time on equal lengths; unequal lengths short-circuit, which leaks nothing useful for a fixed-width hex digest. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function requestSignatureInput(publicHost: string, pathname: string, minute: number): string {
  return `${publicHost}${pathname}${minute}`;
}

export async function verifyRequestSignature(
  secret: string,
  publicHost: string,
  pathname: string,
  signature: string | null | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const minute = Math.floor(now / 60_000);
  for (const m of [minute, minute - 1, minute + 1]) {
    const expected = await hmacHex(secret, requestSignatureInput(publicHost, pathname, m));
    if (timingSafeEqualHex(expected, signature.toLowerCase())) return true;
  }
  return false;
}

export async function verifyBodySignature(secret: string, body: string, signature: string | null | undefined): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  return timingSafeEqualHex(await hmacHex(secret, body), signature.toLowerCase());
}
