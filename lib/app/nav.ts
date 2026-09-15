/**
 * The navigation model for the signed-in app. Pages declare where they sit
 * (which project page, which section) and the shell draws the sidebar from
 * this one table, so a page's sections are the same list in the sidebar and
 * in its tab strip.
 */

export interface NavSection {
  /** The tab value, also the `?tab=` query value that deep-links to it. */
  value: string;
  label: string;
}

/** "connectors" is a project page too, but it sits in the workspace group of the sidebar rather than the project list. */
export type SitePageKey = "overview" | "strategy" | "demand" | "brain" | "content" | "refresh" | "publishing" | "attribution" | "connectors";

export interface SitePageDef {
  key: SitePageKey;
  label: string;
  /** Path segment under /app/sites/[siteId]; empty for the overview. */
  segment: string;
  sections?: NavSection[];
}

export const SITE_PAGES: SitePageDef[] = [
  {
    key: "overview",
    label: "Overview",
    segment: "",
    sections: [
      { value: "install", label: "Install" },
      { value: "checks", label: "Checks" },
      { value: "content", label: "Queue" },
      { value: "crawlers", label: "Crawlers" },
    ],
  },
  {
    key: "strategy",
    label: "Strategy",
    segment: "strategy",
    sections: [
      { value: "topics", label: "Topics" },
      { value: "prompts", label: "Prompts & questions" },
      { value: "competitors", label: "Competitors" },
      { value: "visibility", label: "Visibility" },
    ],
  },
  {
    key: "demand",
    label: "Demand",
    segment: "demand",
    sections: [
      { value: "gaps", label: "Citation gaps" },
      { value: "questions", label: "Questions" },
      { value: "mine", label: "Mine" },
    ],
  },
  {
    key: "brain",
    label: "Brand brain",
    segment: "brain",
    sections: [
      { value: "verify", label: "Verify" },
      { value: "facts", label: "Facts" },
      { value: "entities", label: "Entities" },
      { value: "manifest", label: "Manifesto" },
      { value: "signals", label: "Signals" },
      { value: "sources", label: "Sources" },
    ],
  },
  { key: "content", label: "Content", segment: "content" },
  {
    key: "refresh",
    label: "Refresh",
    segment: "refresh",
    sections: [
      { value: "candidates", label: "Needs a refresh" },
      { value: "inventory", label: "All CMS content" },
    ],
  },
  { key: "publishing", label: "Publishing", segment: "publishing" },
  { key: "attribution", label: "Attribution", segment: "attribution" },
];

export const ORG_SECTIONS: NavSection[] = [
  { value: "members", label: "Members" },
  { value: "billing", label: "Billing" },
  { value: "settings", label: "Settings" },
  { value: "audit", label: "Audit log" },
];

export const OPS_SECTIONS: NavSection[] = [
  { value: "sites", label: "Sites" },
  { value: "orgs", label: "Organisations" },
  { value: "health", label: "Connector health" },
  { value: "spend", label: "LLM spend" },
  { value: "staff", label: "Staff" },
  { value: "audit", label: "Audit log" },
];

export function sitePageHref(siteId: string, page: SitePageDef | SitePageKey): string {
  const def = typeof page === "string" ? SITE_PAGES.find((p) => p.key === page)! : page;
  return def.segment ? `/app/sites/${siteId}/${def.segment}` : `/app/sites/${siteId}`;
}

/** Where another project's copy of the current page lives, so switching projects keeps the page you are on. */
export function pageHrefForSite(siteId: string, page: string | undefined): string {
  if (page === "connectors") return `/app/sites/${siteId}/connectors`;
  const def = SITE_PAGES.find((p) => p.key === page);
  return def ? sitePageHref(siteId, def) : `/app/sites/${siteId}`;
}

export function sitePage(key: SitePageKey): SitePageDef {
  return SITE_PAGES.find((p) => p.key === key)!;
}

/** The deep link to one section of a page. Always explicit: a page's default section depends on its data. */
export function sectionHref(href: string, value: string): string {
  return `${href}?tab=${encodeURIComponent(value)}`;
}

/** Resolve a `?tab=` value against a page's sections, falling back to the default. */
export function resolveTab(sections: NavSection[], requested: string | undefined, fallback: string): string {
  return requested && sections.some((s) => s.value === requested) ? requested : fallback;
}
