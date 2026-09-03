/**
 * robots.txt parsing and path-level evaluation.
 *
 * gtm-agents only evaluated the root path, so `Disallow: /blog/` for GPTBot
 * read as "fully allowed". Here every question is asked about a concrete path,
 * and the audit asks about the paths that matter: the root, the content
 * prefix, and every page it sampled.
 *
 * Semantics follow RFC 9309: groups are sets of User-agent lines followed by
 * rules; the most specific (longest) matching rule wins; on a tie Allow wins;
 * `*` and `$` wildcards are supported; a crawler with its own group ignores the
 * `*` group entirely.
 */

export interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
  /** Verbatim line, for evidence. */
  line: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobotsTxt(content: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "allow everything" and is a no-op for matching.
      if (!value) continue;
      current.rules.push({ type: key, path: value, line: raw.trim() });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

/** Pick the group for a user agent: exact/prefix product-token match, else `*`. */
export function groupFor(robots: ParsedRobots, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a === "*") continue;
      if ((ua.startsWith(a) || a.startsWith(ua)) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  if (best) return best;
  return robots.groups.find((g) => g.agents.includes("*")) ?? null;
}

function patternToRegex(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^{}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(re);
}

export interface PathVerdict {
  allowed: boolean;
  rule: RobotsRule | null;
  /** True when no group applies to this agent at all. */
  unmatched: boolean;
}

export function evaluatePath(robots: ParsedRobots, userAgent: string, path: string): PathVerdict {
  const group = groupFor(robots, userAgent);
  if (!group) return { allowed: true, rule: null, unmatched: true };
  let winner: RobotsRule | null = null;
  let winnerLen = -1;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.path).test(path)) continue;
    const len = rule.path.length;
    if (len > winnerLen || (len === winnerLen && rule.type === "allow" && winner?.type === "disallow")) {
      winner = rule;
      winnerLen = len;
    }
  }
  if (!winner) return { allowed: true, rule: null, unmatched: false };
  return { allowed: winner.type === "allow", rule: winner, unmatched: false };
}

export function isCrawlerAllowed(robots: ParsedRobots, userAgent: string, path = "/"): boolean {
  return evaluatePath(robots, userAgent, path).allowed;
}

/** `User-agent: *` + `Disallow: /` with nothing allowing anything back. */
export function hasBlanketBlock(robots: ParsedRobots): boolean {
  const star = robots.groups.find((g) => g.agents.includes("*"));
  if (!star) return false;
  const blocksRoot = star.rules.some((r) => r.type === "disallow" && (r.path === "/" || r.path === "/*"));
  const allowsSomething = star.rules.some((r) => r.type === "allow");
  return blocksRoot && !allowsSomething;
}
