import type { ConnectionRow, ConnectorProvider } from "./types";

/**
 * The catalogue: every connector the product offers, connected or not, so
 * the Connectors page is a fixed list a customer can read top to bottom
 * rather than a table of whatever happens to exist. Pure; the page adds the
 * live rows.
 *
 * One provider can back more than one entry: the Google grant covers Search
 * Console and GA4, which are two different products to the customer and get
 * two cards, each configured on the same connection.
 */

export type ConnectorKey = "gsc" | "ga4" | "profound" | "webflow" | "website" | "slack" | "custom";
export type ConnectorGroup = "measure" | "publish" | "brain";
export type ConnectorScope = "site" | "org";
export type ConnectorAuth = "oauth" | "token" | "none" | "custom";
export type ConnectorState = "connected" | "needs_setup" | "error" | "not_connected";

export interface ConnectorDef {
  key: ConnectorKey;
  provider: ConnectorProvider;
  name: string;
  tagline: string;
  description: string;
  /** Site-scoped connectors bind to one project; org-scoped ones serve every project. */
  scope: ConnectorScope;
  group: ConnectorGroup;
  auth: ConnectorAuth;
  /** Where the data lands, in the customer's words. */
  feeds: string[];
}

export const CONNECTOR_CATALOG: ConnectorDef[] = [
  {
    key: "gsc",
    provider: "google",
    name: "Google Search Console",
    tagline: "Clicks, impressions and position per query and page.",
    description: "The only source of query-level demand for your own site. Fills the demand queue, the attribution view and the refresh ranking (site-wide page totals, so CMS posts outside the proxy prefix count too).",
    scope: "site",
    group: "measure",
    auth: "oauth",
    feeds: ["Demand", "Attribution", "Refresh"],
  },
  {
    key: "ga4",
    provider: "google",
    name: "Google Analytics 4",
    tagline: "Sessions referred by ChatGPT, Perplexity, Gemini and Copilot.",
    description: "AI-referral traffic per landing page: the third attribution signal next to citations and crawler fetches. Same Google grant as Search Console; pick the property.",
    scope: "site",
    group: "measure",
    auth: "oauth",
    feeds: ["Attribution"],
  },
  {
    key: "profound",
    provider: "profound",
    name: "Profound",
    tagline: "AI visibility, prompts and citations across engines.",
    description: "Enrichment, never a dependency: prompts become tracked questions, each answer a snapshot with its citations, visibility a metric. Every Profound number is labelled as Profound's, and the product computes everything with it off.",
    scope: "site",
    group: "measure",
    auth: "token",
    feeds: ["Strategy → Visibility", "Citation gaps", "Refresh"],
  },
  {
    key: "webflow",
    provider: "webflow",
    name: "Webflow",
    tagline: "Publish into your CMS and inventory what is already there.",
    description: "A site API token with cms:read and cms:write. Articles are pushed into a collection as posts (and kept updated); every collection is inventoried nightly so existing posts can be scored for a refresh and rewritten in place.",
    scope: "site",
    group: "publish",
    auth: "token",
    feeds: ["Publishing", "Refresh"],
  },
  {
    key: "website",
    provider: "website",
    name: "Your website",
    tagline: "Your own pages, crawled into the brand brain.",
    description: "Created with the project and re-crawled daily, so a new pricing page or a redesign shows up in briefs without anyone re-running onboarding. No credentials.",
    scope: "site",
    group: "brain",
    auth: "none",
    feeds: ["Brand brain", "Business profile"],
  },
  {
    key: "slack",
    provider: "slack",
    name: "Slack",
    tagline: "Channels as brand-brain sources; approvals and alerts as messages.",
    description: "Reads history only from the channels you pick (nothing by default). Optionally a channel for brief/draft approvals with one-click decisions, and one for proxy-health alerts.",
    scope: "org",
    group: "brain",
    auth: "oauth",
    feeds: ["Brand brain", "Approvals", "Alerts"],
  },
  {
    key: "custom",
    provider: "custom",
    name: "Custom source (API or MCP)",
    tagline: "Any HTTP endpoint that returns JSON or text, or any MCP server.",
    description: "Point it at an API (a JSON list of records, mapped with a small field map, or a page of text) or an MCP server (every resource it lists is read). Records land in the brand brain like Slack messages do. Tokens go to Vault; the URL is checked against private networks.",
    scope: "org",
    group: "brain",
    auth: "custom",
    feeds: ["Brand brain"],
  },
];

export const GROUP_LABELS: Record<ConnectorGroup, { title: string; blurb: string }> = {
  measure: { title: "Measure", blurb: "Where demand, traffic and AI visibility come from. Every metric names its source." },
  publish: { title: "Publish", blurb: "Where articles go besides the proxy, and what already lives there." },
  brain: { title: "Brand brain sources", blurb: "What the briefs and drafts are grounded in. Read-only, opt-in per channel or endpoint." },
};

export function connectorDef(key: ConnectorKey): ConnectorDef {
  return CONNECTOR_CATALOG.find((d) => d.key === key)!;
}

/** Live rows (never disconnected ones) that back a catalogue entry, optionally for one site. */
export function connectionsFor(def: Pick<ConnectorDef, "provider" | "scope">, connections: ConnectionRow[], siteId?: string | null): ConnectionRow[] {
  return connections.filter((c) => c.provider === def.provider && c.status !== "disconnected" && (!siteId || def.scope === "org" || c.site_id === siteId || c.site_id === null));
}

/**
 * What a card says about one connection. A Google grant with no property
 * chosen, or a Slack install with no channels, is "needs setup": the token
 * is there and nothing is being read.
 */
export function connectorState(def: Pick<ConnectorDef, "key">, conn: ConnectionRow | null | undefined): ConnectorState {
  if (!conn || conn.status === "disconnected") return "not_connected";
  if (conn.status === "error") return "error";
  const cfg = conn.config as Record<string, unknown>;
  if (def.key === "gsc" && !cfg.gscProperty) return "needs_setup";
  if (def.key === "ga4" && !cfg.ga4PropertyId) return "needs_setup";
  if (def.key === "slack" && conn.scope.length === 0 && !cfg.approvalsChannel && !cfg.alertsChannel) return "needs_setup";
  if (conn.status === "pending") return "needs_setup";
  if (!conn.enabled || conn.status === "disabled") return "needs_setup";
  return "connected";
}

export const STATE_LABELS: Record<ConnectorState, string> = {
  connected: "connected",
  needs_setup: "needs setup",
  error: "error",
  not_connected: "not connected",
};
