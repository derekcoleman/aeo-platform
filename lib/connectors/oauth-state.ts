import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * OAuth `state` for every provider: an HMAC-signed, expiring envelope that
 * carries who started the flow. The callback trusts the state — not the
 * session — to know which org and site the token belongs to, so it must be
 * unforgeable and single-purpose. Format: base64url(json).base64url(hmac).
 */

const stateSchema = z.object({
  orgId: z.guid(),
  siteId: z.guid().nullable(),
  provider: z.enum(["slack", "google", "profound"]),
  userId: z.string().nullable().optional(),
  nonce: z.string().min(8),
  exp: z.number().int(),
  /** Where to send the browser after the callback. Root-relative only. */
  returnTo: z.string().regex(/^\/(?!\/)/).optional(),
});
export type OAuthState = z.infer<typeof stateSchema>;

export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function b64u(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, payload: string): string {
  return b64u(createHmac("sha256", secret).update(payload).digest());
}

export function createOAuthState(secret: string, input: Omit<OAuthState, "nonce" | "exp">, now: Date = new Date()): string {
  if (!secret || secret.length < 16) throw new Error("OAUTH_STATE_SECRET must be at least 16 characters");
  const state: OAuthState = { ...input, nonce: b64u(randomBytes(12)), exp: now.getTime() + OAUTH_STATE_TTL_MS };
  const payload = b64u(Buffer.from(JSON.stringify(state)));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyOAuthState(secret: string, state: string | null | undefined, now: Date = new Date()): OAuthState | null {
  if (!secret || !state) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const r = stateSchema.safeParse(parsed);
  if (!r.success) return null;
  if (r.data.exp < now.getTime()) return null;
  return r.data;
}
