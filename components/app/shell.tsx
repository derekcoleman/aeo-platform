import type { Route } from "next";
import Link from "next/link";
import { BarChart3, Brain, ChevronRight, Compass, FileText, Globe, LayoutDashboard, LayoutGrid, LogOut, Plug, RefreshCw, Search, Send, Settings, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectSwitcher, type SwitcherProject } from "@/components/app/project-switcher";
import { SidebarItem } from "@/components/app/sidebar-item";
import { OPS_SECTIONS, SITE_PAGES, opsHref, pageHrefForSite, pageLabel, settingsHref, sitePageHref, type NavSection, type ShellPage, type SitePageKey } from "@/lib/app/nav";
import { listSites, type SiteRow } from "@/lib/app/store";
import { visibleOrgIds, type SessionUser } from "@/lib/auth/session";

type Icon = typeof LayoutGrid;

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: Icon;
  /** Sections listed under the item while it is the current page. */
  sections?: NavSection[];
}

interface NavGroup {
  key: string;
  title?: string;
  items: NavItem[];
  /** Key of the item that is the current page, if any. */
  current?: string;
}

const PAGE_ICONS: Record<SitePageKey, Icon> = {
  overview: LayoutDashboard,
  strategy: Compass,
  demand: Search,
  brain: Brain,
  content: FileText,
  refresh: RefreshCw,
  publishing: Send,
  attribution: BarChart3,
  connectors: Plug,
};

/** How many projects the sidebar lists by name when no project is open. */
const PROJECT_LIST_MAX = 8;

export interface ShellSite {
  id: string;
  name: string;
  org_id: string;
  canonical_domain: string;
  path_prefix: string;
}

export interface AppShellProps {
  user: SessionUser;
  /** Which area is highlighted. Defaults to the project area. */
  active?: "projects" | "settings" | "ops";
  /** The project whose pages fill the sidebar. */
  site?: ShellSite | null;
  /** The page being shown; drives the highlight, the sections that unfold, the switcher's links and the breadcrumb. */
  page?: ShellPage;
  /** The section (tab) currently shown, after `resolveTab`. */
  section?: string;
  children: React.ReactNode;
}

/**
 * The signed-in frame. Server component; the only interactive piece is the
 * project switcher. The sidebar is: the switcher; the current project's
 * pages with the open page's sections nested under it, or the list of
 * projects when none is open (so the way back is always one click); then,
 * pinned to the bottom, the small Settings and Ops entries and the account.
 * Every page carries a breadcrumb.
 */
export async function AppShell({ user, active = "projects", site, page, section, children }: AppShellProps) {
  const sites = await listSites(visibleOrgIds(user));
  const { main, footer } = buildGroups({ user, active, site: site ?? null, page, sites });
  const projects: SwitcherProject[] = sites.map((s) => ({ id: s.id, name: s.name, domain: s.canonical_domain, href: pageHrefForSite(s.id, page, page === "settings" ? section : null) }));
  const crumbs = breadcrumbs(site ?? null, page);
  return (
    <div className="flex min-h-screen">
      <aside className="bg-muted/40 hidden w-60 shrink-0 flex-col border-r px-3 py-5 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto">
        <Link href={"/app" as Route} className="px-2 text-sm font-semibold tracking-tight">AEO Platform</Link>
        <div className="mt-4"><ProjectSwitcher projects={projects} currentId={site?.id ?? null} /></div>
        <nav className="mt-5 flex flex-col gap-6" aria-label="Main">
          {main.map((g) => <SidebarGroup key={g.key} group={g} section={section} />)}
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t pt-4">
          <nav aria-label="Workspace">
            <ul className="flex flex-col gap-0.5">
              {footer.items.map((n) => (
                <SidebarItem key={n.key} href={n.href} label={n.label} icon={<n.icon className="size-3.5 shrink-0" />} sections={n.sections} current={footer.current === n.key} section={section} compact />
              ))}
            </ul>
          </nav>
          <div className="flex items-center justify-between gap-2 px-2">
            <p className="text-muted-foreground min-w-0 truncate text-xs" title={user.email ?? undefined}>{user.name ?? user.email}</p>
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground h-7 px-1.5 text-xs" title="Sign out"><LogOut className="size-3.5" /> Sign out</Button>
            </form>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b md:hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <Link href={"/app" as Route} className="shrink-0 text-sm font-semibold">AEO Platform</Link>
            <ProjectSwitcher projects={projects} currentId={site?.id ?? null} compact />
            <nav className="flex min-w-0 flex-1 justify-end gap-3 overflow-x-auto text-sm whitespace-nowrap" aria-label="Workspace">
              {footer.items.map((n) => <Link key={n.key} href={n.href as Route} className={footer.current === n.key ? "font-medium" : "text-muted-foreground"}>{n.label}</Link>)}
            </nav>
          </div>
          {main.map((g) => (
            <nav key={g.key} className="flex gap-1 overflow-x-auto border-t px-3 py-2 text-sm whitespace-nowrap" aria-label={g.title}>
              {g.items.map((n) => <Link key={n.key} href={n.href as Route} className={`shrink-0 rounded-md px-2 py-1 ${g.current === n.key ? "bg-background font-medium shadow-xs" : "text-muted-foreground"}`}>{n.label}</Link>)}
            </nav>
          ))}
        </header>
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {crumbs.length ? (
            <nav aria-label="Breadcrumb" className="text-muted-foreground mb-4 flex flex-wrap items-center gap-1 text-xs">
              {crumbs.map((c, i) => (
                <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                  {i ? <ChevronRight className="size-3" aria-hidden /> : null}
                  {c.href ? <Link href={c.href as Route} className="hover:text-foreground underline-offset-2 hover:underline">{c.label}</Link> : <span className="text-foreground font-medium" aria-current="page">{c.label}</span>}
                </span>
              ))}
            </nav>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}

/** Projects › project › page. The last crumb is the page you are on; the ones before it are links back. */
export function breadcrumbs(site: ShellSite | null, page: ShellPage | undefined): { label: string; href?: string }[] {
  if (!page) return [];
  const crumbs: { label: string; href?: string }[] = [{ label: "Projects", href: "/app" }];
  if (site) {
    if (page === "overview") return [...crumbs, { label: site.name }];
    crumbs.push({ label: site.name, href: sitePageHref(site.id, "overview") });
  }
  crumbs.push({ label: pageLabel(page) });
  return crumbs;
}

function SidebarGroup({ group, section }: { group: NavGroup; section?: string }) {
  return (
    <div>
      {group.title ? <p className="text-muted-foreground mb-1 px-2 text-[11px] font-medium tracking-wide uppercase">{group.title}</p> : null}
      <ul className="flex flex-col gap-0.5">
        {group.items.map((n) => (
          <SidebarItem key={n.key} href={n.href} label={n.label} icon={<n.icon className="size-4 shrink-0" />} sections={n.sections} current={group.current === n.key} section={section} />
        ))}
      </ul>
    </div>
  );
}

function buildGroups({ user, active, site, page, sites }: { user: SessionUser; active: NonNullable<AppShellProps["active"]>; site: ShellSite | null; page?: ShellPage; sites: SiteRow[] }): { main: NavGroup[]; footer: NavGroup } {
  const main: NavGroup[] = [];
  if (site) {
    const items: NavItem[] = SITE_PAGES.map((p) => ({ key: p.key, href: sitePageHref(site.id, p), label: p.label, icon: PAGE_ICONS[p.key], sections: p.sections }));
    main.push({ key: "project", title: site.name, items, current: active === "projects" && page && page in PAGE_ICONS ? page : undefined });
  } else if (sites.length > 0) {
    // No project open (the projects index, workspace-wide Settings or Ops):
    // list the projects so the way back is one click, never a hunt.
    const items: NavItem[] = sites.slice(0, PROJECT_LIST_MAX).map((s) => ({ key: s.id, href: sitePageHref(s.id, "overview"), label: s.name, icon: Globe }));
    if (sites.length > PROJECT_LIST_MAX) items.push({ key: "all", href: "/app", label: `All ${sites.length} projects`, icon: LayoutGrid });
    main.push({ key: "projects", title: "Projects", items });
  }

  // Settings and Ops follow the project: from a project they open its
  // organisation's settings and the console scoped to it. The console's
  // sections unfold under Ops while it is open.
  const footer: NavGroup = {
    key: "workspace",
    current: active === "settings" ? "settings" : active === "ops" ? "ops" : undefined,
    items: [
      { key: "settings", href: settingsHref(site?.id), label: "Settings", icon: Settings },
      ...(user.isStaff ? [{ key: "ops", href: opsHref(site?.id), label: site ? `Ops · ${site.name}` : "Ops", icon: ShieldCheck, sections: OPS_SECTIONS }] : []),
    ],
  };
  return { main, footer };
}

export function PageHeader({ title, eyebrow, description, children }: { title: string; eyebrow?: React.ReactNode; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted-foreground mt-1 text-sm">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
