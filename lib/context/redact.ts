/**
 * Redaction runs BEFORE embedding, never after: a chunk row and its vector
 * must be derived from text that has already had PII and credentials
 * removed. Deterministic regexes only in v1 (an LLM pass for unapproved
 * customer names is a later slice); every replacement is a fixed token so a
 * redacted chunk is recognisable as such and never mistaken for prose.
 *
 * Order matters: secrets first (a token can contain digit runs that look
 * like phone numbers), then card numbers (Luhn-checked so an order id does
 * not vanish), then emails, then phones. Slack mentions (`<@U…>`, `<#C…>`)
 * and URLs are protected so channel/user references and links survive.
 */

export interface RedactionResult {
  text: string;
  counts: { email: number; phone: number; card: number; secret: number };
  changed: boolean;
}

export const REDACTION_TOKENS = { email: "[email]", phone: "[phone]", card: "[card]", secret: "[secret]" } as const;

const SECRET_RES: RegExp[] = [
  /\bxox[abpe]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bya29\.[A-Za-z0-9_-]{20,}/g, // Google OAuth access tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, // Authorization headers
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13–19 digits with optional separators, then Luhn-checked.
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
// Three shapes only: international with a leading +, North American with a
// parenthesised area code, or the bare 3-3-4 form. Anything else that is
// merely digits with separators (order ids, version strings) is left alone.
const PHONE_RE = /(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d[\d .-]{5,14}\d|\(\d{3}\)[ .-]?\d{3}[ .-]\d{4}|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b)/g;

const PROTECT_RE = /<[@#][A-Z0-9]+(?:\|[^>]*)?>|https?:\/\/[^\s<>)]+/g;
// Placeholder for lifted spans: a control character never present in prose.
const SENTINEL = "";
const SENTINEL_RE = /(\d+)/g;

export function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redact(input: string): RedactionResult {
  const counts = { email: 0, phone: 0, card: 0, secret: 0 };
  // Lift protected spans out so their contents are never rewritten.
  const protectedSpans: string[] = [];
  let text = input.replace(PROTECT_RE, (m) => {
    protectedSpans.push(m);
    return `${SENTINEL}${protectedSpans.length - 1}${SENTINEL}`;
  });
  for (const re of SECRET_RES) {
    text = text.replace(re, () => {
      counts.secret++;
      return REDACTION_TOKENS.secret;
    });
  }
  text = text.replace(CARD_RE, (m) => {
    if (!luhnValid(m)) return m;
    counts.card++;
    return REDACTION_TOKENS.card;
  });
  text = text.replace(EMAIL_RE, () => {
    counts.email++;
    return REDACTION_TOKENS.email;
  });
  text = text.replace(PHONE_RE, (m) => {
    if (m.replace(/\D/g, "").length < 10) return m;
    counts.phone++;
    return REDACTION_TOKENS.phone;
  });
  text = text.replace(SENTINEL_RE, (_, i: string) => protectedSpans[Number(i)] ?? "");
  return { text, counts, changed: text !== input };
}
