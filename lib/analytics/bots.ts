/**
 * The AI-crawler catalogue and the verification that makes a hit trustworthy.
 *
 * A user-agent string is a claim, not a fact — anyone can send `GPTBot`. Every
 * operator that matters publishes the IP ranges its crawlers use, so a hit is
 * `verified` only when the source address falls inside the published ranges
 * for the family the UA claims. Families without a published list stay
 * unverified, and the dashboard keeps the two apart rather than blending them.
 *
 * `purpose` is the commercial split: `train` takes months to matter,
 * `search_index` weeks, and `live_fetch` is a model fetching this URL right
 * now, mid-answer, for a real person — the highest-value telemetry we have.
 */
export type BotPurpose = "train" | "search_index" | "live_fetch" | "other";

export interface BotSpec {
  family: string;
  operator: string;
  purpose: BotPurpose;
  /** Case-insensitive match against the raw user agent. */
  ua: RegExp;
  /** Published JSON of IP prefixes, when the operator has one. */
  rangesUrl: string | null;
}

/** Order matters: user-triggered agents share prefixes with the base crawlers (`ChatGPT-User` vs `GPTBot`). */
export const BOT_CATALOG: readonly BotSpec[] = [
  { family: "chatgpt-user", operator: "OpenAI", purpose: "live_fetch", ua: /ChatGPT-User/i, rangesUrl: "https://openai.com/chatgpt-user.json" },
  { family: "perplexity-user", operator: "Perplexity", purpose: "live_fetch", ua: /Perplexity-User/i, rangesUrl: "https://www.perplexity.com/perplexity-user.json" },
  { family: "claude-user", operator: "Anthropic", purpose: "live_fetch", ua: /Claude-User/i, rangesUrl: null },
  { family: "gemini-user", operator: "Google", purpose: "live_fetch", ua: /Gemini-User/i, rangesUrl: "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json" },
  { family: "oai-searchbot", operator: "OpenAI", purpose: "search_index", ua: /OAI-SearchBot/i, rangesUrl: "https://openai.com/searchbot.json" },
  { family: "perplexitybot", operator: "Perplexity", purpose: "search_index", ua: /PerplexityBot/i, rangesUrl: "https://www.perplexity.com/perplexitybot.json" },
  { family: "claude-searchbot", operator: "Anthropic", purpose: "search_index", ua: /Claude-SearchBot/i, rangesUrl: null },
  { family: "bingbot", operator: "Microsoft", purpose: "search_index", ua: /bingbot/i, rangesUrl: "https://www.bing.com/toolbox/bingbot.json" },
  { family: "gptbot", operator: "OpenAI", purpose: "train", ua: /GPTBot/i, rangesUrl: "https://openai.com/gptbot.json" },
  { family: "claudebot", operator: "Anthropic", purpose: "train", ua: /ClaudeBot/i, rangesUrl: null },
  { family: "ccbot", operator: "Common Crawl", purpose: "train", ua: /CCBot/i, rangesUrl: null },
  { family: "google-extended", operator: "Google", purpose: "train", ua: /Google-Extended/i, rangesUrl: "https://developers.google.com/static/search/apis/ipranges/googlebot.json" },
  { family: "applebot-extended", operator: "Apple", purpose: "train", ua: /Applebot-Extended/i, rangesUrl: "https://search.developer.apple.com/applebot.json" },
  { family: "bytespider", operator: "ByteDance", purpose: "train", ua: /Bytespider/i, rangesUrl: null },
  { family: "googlebot", operator: "Google", purpose: "search_index", ua: /Googlebot/i, rangesUrl: "https://developers.google.com/static/search/apis/ipranges/googlebot.json" },
];

const BY_FAMILY = new Map(BOT_CATALOG.map((b) => [b.family, b]));

export function botSpec(family: string): BotSpec | undefined {
  return BY_FAMILY.get(family);
}

export function classifyUserAgent(ua: string | null | undefined): { family: string; purpose: BotPurpose } | null {
  if (!ua) return null;
  for (const b of BOT_CATALOG) if (b.ua.test(ua)) return { family: b.family, purpose: b.purpose };
  return null;
}

// ── IP ranges ───────────────────────────────────────────────────────────────

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

export function parseIp(ip: string): ParsedIp | null {
  const s = ip.trim();
  if (!s) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is how some edges hand v4 addresses over.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return parseIp(mapped[1]!);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
    const parts = s.split(".").map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return { version: 4, value: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n) };
  }
  if (s.includes(":")) {
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
    const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
    if (groups.length !== 8) return null;
    let value = 0n;
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      value = (value << 16n) + BigInt(parseInt(g, 16));
    }
    return { version: 6, value };
  }
  return null;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const addr = parseIp(ip);
  const net = base ? parseIp(base) : null;
  if (!addr || !net || addr.version !== net.version) return false;
  const width = net.version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return addr.value >> shift === net.value >> shift;
}

/**
 * Verified when the address is inside the family's published ranges; `null`
 * when the family has no ranges to check against (unverifiable, which is not
 * the same as spoofed).
 */
export function verifyBotIp(family: string, ip: string | null | undefined, ranges: Record<string, string[]>): boolean | null {
  const list = ranges[family];
  if (!list || list.length === 0) return null;
  if (!ip) return false;
  return list.some((c) => ipInCidr(ip, c));
}

/** Every operator publishes the same shape: `{ prefixes: [{ ipv4Prefix } | { ipv6Prefix }] }`. */
export function parsePublishedRanges(json: unknown): string[] {
  if (Array.isArray(json)) return json.filter((x): x is string => typeof x === "string" && x.includes("/"));
  if (!json || typeof json !== "object") return [];
  const prefixes = (json as { prefixes?: unknown }).prefixes;
  if (!Array.isArray(prefixes)) return [];
  const out: string[] = [];
  for (const p of prefixes) {
    if (!p || typeof p !== "object") continue;
    const v4 = (p as { ipv4Prefix?: unknown }).ipv4Prefix;
    const v6 = (p as { ipv6Prefix?: unknown }).ipv6Prefix;
    if (typeof v4 === "string" && v4.includes("/")) out.push(v4);
    if (typeof v6 === "string" && v6.includes("/")) out.push(v6);
  }
  return out;
}

export async function fetchPublishedRanges(url: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ranges ${url}: status ${res.status}`);
  return parsePublishedRanges(await res.json());
}
