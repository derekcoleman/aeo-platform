import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request signing (v0): `v0=hex(hmac_sha256(secret, "v0:" + ts + ":" + body))`.
 * The timestamp window blocks replay; the constant-time compare blocks the
 * byte-at-a-time oracle. Verify on the raw body — re-serialised JSON will
 * not match.
 */

export const SLACK_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export interface VerifySlackSignatureInput {
  signingSecret: string;
  timestamp: string | null;
  body: string;
  signature: string | null;
  now?: Date;
}

export function slackSignature(signingSecret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { signingSecret, timestamp, body, signature } = input;
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = (input.now ?? new Date()).getTime();
  if (Math.abs(now - ts * 1000) > SLACK_SIGNATURE_WINDOW_MS) return false;
  const expected = Buffer.from(slackSignature(signingSecret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
