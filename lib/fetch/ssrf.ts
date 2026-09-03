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

export function isBlockedIpv6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "::") return true;
  // Unique local (fc00::/7), link local (fe80::/10), multicast (ff00::/8).
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("ff")) {
    return true;
  }
  // IPv4-mapped: ::ffff:a.b.c.d — apply the v4 rules.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare intranet names
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedIpv4(h);
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
