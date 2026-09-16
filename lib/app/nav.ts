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

/**
 * The settings hub (/settings): everything that configures the workspace,
 * kept apart from the project pages. The first five are for owners and
 * admins; `settingsSections` adds the staff-only ones.
 */
export const SETTINGS_SECTIONS: NavSection[] = [
  { value: "general", label: "General" },
  { value: "members", label: "Members" },
  { value: "billing", label: "Billing" },
  { value: "connectors", label: "Connectors" },
  { value: "audit", label: "Audit log" },
];

/** Staff-only settings: the project's theme (needs a project), the deployment checklist, the staff list. */
export const STAFF_SETTINGS_SECTIONS: NavSection[] = [
  { value: "theme", label: "Theme" },
  { value: "deployment", label: "Deployment" },
  { value: "staff", label: "Staff" },
];

export function settingsSections(opts: { isStaff: boolean; hasSite: boolean }): NavSection[] {
  if (!opts.isStaff) return SETTINGS_SECTIONS;
  return [...SETTINGS_SECTIONS, ...STAFF_SETTINGS_SECTIONS.filter((s) => s.value !== "theme" || opts.hasSite)];
}

/** Older spellings of a settings tab that links and Stripe return URLs may still carry. */
export function legacySettingsTab(tab: string | undefined): string | undefined {
  if (tab === "settings" || tab === "organisation") return "general";
  return tab;
}

/** Every page the shell can show; drives the sidebar highlight, the switcher's links and the breadcrumb. */
export type ShellPage = SitePageKey | "settings" | "console";

export function pageLabel(page: ShellPage): string {
  if (page === "connectors") return "Connectors";
  if (page === "settings") return "Settings";
  if (page === "console") return "Ops console";
  return SITE_PAGES.find((p) => p.key === page)?.label ?? page;
}

/**
 * The settings hub for a project's organisation (the project stays in the
 * sidebar) or for one organisation by id, optionally opened on a tab; bare
 * /settings picks the caller's first organisation.
 */
export function settingsHref(siteId?: string | null, orgId?: string | null, tab?: string | null): string {
  const q = new URLSearchParams();
  if (siteId) q.set("site", siteId);
  if (orgId) q.set("org", orgId);
  if (tab) q.set("tab", tab);
  const query = q.toString();
  return query ? `/settings?${query}` : "/settings";
}

export const OPS_SECTIONS: NavSection[] = [
  { value: "sites", label: "Sites" },
  { value: "orgs", label: "Organisations" },
  { value: "health", label: "Connector health" },
  { value: "spend", label: "LLM spend" },
  { value: "audit", label: "Audit log" },
];

export function sitePageHref(siteId: string, page: SitePageDef | SitePageKey): string {
  const def = typeof page === "string" ? SITE_PAGES.find((p) => p.key === page)! : page;
  return def.segment ? `/app/sites/${siteId}/${def.segment}` : `/app/sites/${siteId}`;
}

/** The ops console scoped to a project, or platform-wide when there is no project. */
export function opsHref(siteId: string | null | undefined): string {
  return siteId ? `/ops?site=${encodeURIComponent(siteId)}` : "/ops";
}

/** Where another project's copy of the current page lives, so switching projects keeps the page (and settings tab) you are on. */
export function pageHrefForSite(siteId: string, page: string | undefined, section?: string | null): string {
  if (page === "connectors") return settingsHref(siteId, null, "connectors");
  if (page === "settings") return settingsHref(siteId, null, section);
  if (page === "console") return opsHref(siteId);
  const def = SITE_PAGES.find((p) => p.key === page);
  return def ? sitePageHref(siteId, def) : `/app/sites/${siteId}`;
}

export function sitePage(key: SitePageKey): SitePageDef {
  return SITE_PAGES.find((p) => p.key === key)!;
}

/** The deep link to one section of a page. Always explicit: a page's default section depends on its data. */
export function sectionHref(href: string, value: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}tab=${encodeURIComponent(value)}`;
}

/** Resolve a `?tab=` value against a page's sections, falling back to the default. */
export function resolveTab(sections: NavSection[], requested: string | undefined, fallback: string): string {
  return requested && sections.some((s) => s.value === requested) ? requested : fallback;
}
