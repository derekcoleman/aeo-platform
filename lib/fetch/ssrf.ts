/**
 * SSRF guard for every outbound fetch the platform makes on a user's behalf.
 *
 * The audit, the preflight, the theme extractor and the connectors all fetch
 * URLs that a customer (or an anonymous visitor to /audit) typed in. None of
 * them may reach our own network. This module is the single decision point:
 * every fetch helper calls `checkSsrf` and nothing else re-implements the
 * blocklist (gtm-agents had two inline copies, one of which blocked all of
 * 172.* instead of 172.16/12).
 */

export interface SsrfVerdict {
  safe: boolean;
  reason?: string;
  url?: URL;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

const BLOCKED_PATH_PREFIXES = ["/latest/meta-data", "/latest/user-data", "/computeMetadata"];

/** Ports we never speak to from a user-controlled URL, even on public hosts. */
const BLOCKED_PORTS = new Set([22, 25, 2379, 3306, 5432, 6379, 9200, 11211, 27017]);

interface Cidr {
  base: number;
  bits: number;
}

const BLOCKED_V4: Cidr[] = [
  cidr("0.0.0.0", 8),
  cidr("10.0.0.0", 8),
  cidr("100.64.0.0", 10),
  cidr("127.0.0.0", 8),
  cidr("169.254.0.0", 16),
  cidr("172.16.0.0", 12),
  cidr("192.0.0.0", 24),
  cidr("192.168.0.0", 16),
  cidr("198.18.0.0", 15),
  cidr("224.0.0.0", 4),
  cidr("240.0.0.0", 4),
];

function cidr(ip: string, bits: number): Cidr {
  return { base: ipv4ToInt(ip), bits };
}

export function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n < 0) return false;
  return BLOCKED_V4.some(({ base, bits }) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

/**
 * An IPv6 literal as its 16 bytes, or null when it is not one. Accepts the
 * URL form (`[...]`), `::` compression and a trailing dotted quad
 * (`::ffff:127.0.0.1`). No zone ids: a URL host cannot carry one, and a
 * resolved address that does is refused by the caller failing closed.
 */
export function parseIpv6(input: string): Uint8Array | null {
  let h = input.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h.includes(":") || /[^0-9a-f:.]/.test(h)) return null;
  if (h.includes(".")) {
    const at = h.lastIndexOf(":");
    const quad = h.slice(at + 1);
    const n = /^\d{1,3}(\.\d{1,3}){3}$/.test(quad) ? ipv4ToInt(quad) : -1;
    if (n < 0) return null;
    h = `${h.slice(0, at + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

interface Cidr6 {
  prefix: Uint8Array;
  bits: number;
  /** Byte offset of an IPv4 address embedded in this range; it gets the v4 rules instead of a block. */
  v4At?: number;
}

function cidr6(prefix: string, bits: number, v4At?: number): Cidr6 {
  return { prefix: parseIpv6(prefix)!, bits, v4At };
}

function inCidr6(addr: Uint8Array, { prefix, bits }: Cidr6): boolean {
  for (let i = 0; i < 16 && bits > i * 8; i++) {
    const take = Math.min(8, bits - i * 8);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((addr[i]! & mask) !== (prefix[i]! & mask)) return false;
  }
  return true;
}

/**
 * Ranges that carry an IPv4 address inside an IPv6 one. A request to any of
 * them reaches that IPv4 address (dual-stack socket, NAT64 gateway, 6to4
 * relay), so the address is judged by the v4 rules, not waved through as
 * "some IPv6 host". `::ffff:7f00:1` — which is what the URL parser makes of
 * `[::ffff:127.0.0.1]` — is the canonical bypass this closes.
 */
const EMBEDDED_V4: Cidr6[] = [
  cidr6("::ffff:0:0", 96, 12), // IPv4-mapped
  cidr6("::ffff:0:0:0", 96, 12), // IPv4-translated (SIIT)
  cidr6("64:ff9b::", 96, 12), // NAT64 well-known prefix
  cidr6("2002::", 16, 2), // 6to4
  cidr6("::", 96, 12), // IPv4-compatible (deprecated); also :: and ::1 via 0.0.0.0/8 and 127/8
];

/**
 * Special-purpose space that is never a public web server. The ranges outside
 * 2000::/3 are also caught by the global-unicast rule below; they are listed
 * so the intent survives a change to that rule.
 */
const BLOCKED_V6: Cidr6[] = [
  cidr6("64:ff9b:1::", 48), // local-use NAT64
  cidr6("100::", 64), // discard-only
  cidr6("2001::", 23), // IETF protocol assignments: Teredo (2001::/32), benchmarking, ORCHID
  cidr6("2001:db8::", 32), // documentation
  cidr6("3fff::", 20), // documentation
  cidr6("5f00::", 16), // SRv6 SIDs
  cidr6("fc00::", 7), // unique local
  cidr6("fe80::", 10), // link local
  cidr6("fec0::", 10), // site local (deprecated)
  cidr6("ff00::", 8), // multicast
];

/** Global unicast. Anything outside it is reserved or special-purpose. */
const GLOBAL_UNICAST = cidr6("2000::", 3);

/** Fails closed: an address we cannot parse is blocked, never assumed public. */
export function isBlockedIpv6(ip: string): boolean {
  const addr = parseIpv6(ip);
  if (!addr) return true;
  for (const range of EMBEDDED_V4) {
    if (!inCidr6(addr, range)) continue;
    const at = range.v4At!;
    return isBlockedIpv4(`${addr[at]}.${addr[at + 1]}.${addr[at + 2]}.${addr[at + 3]}`);
  }
  return BLOCKED_V6.some((range) => inCidr6(addr, range)) || !inCidr6(addr, GLOBAL_UNICAST);
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare intranet names
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return ipv4ToInt(h) < 0 || isBlockedIpv4(h);
  if (h.includes(":")) return isBlockedIpv6(h);
  return false;
}

/**
 * Decide whether a URL may be fetched. Only the literal target is evaluated
 * here; DNS-rebinding defence lives in the fetch helper, which re-checks the
 * resolved address (see `lib/fetch/fetch.ts`).
 */
export function checkSsrf(input: string | URL): SsrfVerdict {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return { safe: false, reason: "invalid url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: `protocol ${url.protocol} not allowed` };
  }
  if (url.username || url.password) {
    return { safe: false, reason: "credentials in url" };
  }
  if (isBlockedHostname(url.hostname)) {
    return { safe: false, reason: `host ${url.hostname} is not publicly routable` };
  }
  if (url.port && BLOCKED_PORTS.has(Number(url.port))) {
    return { safe: false, reason: `port ${url.port} not allowed` };
  }
  const path = url.pathname;
  if (BLOCKED_PATH_PREFIXES.some((p) => path.startsWith(p))) {
    return { safe: false, reason: "metadata path" };
  }
  return { safe: true, url };
}
