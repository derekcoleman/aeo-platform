import type { Route } from "next";
import Link from "next/link";
import { BarChart3, Brain, Building2, Compass, FileText, LayoutDashboard, LayoutGrid, ListChecks, LogOut, Palette, Plug, RefreshCw, Search, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectSwitcher, type SwitcherProject } from "@/components/app/project-switcher";
import { ORG_SECTIONS, OPS_SECTIONS, SITE_PAGES, pageHrefForSite, sectionHref, sitePageHref, type NavSection, type SitePageKey } from "@/lib/app/nav";
import { listSites } from "@/lib/app/store";
import { canManage } from "@/lib/auth/roles";
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

export interface ShellSite {
  id: string;
  name: string;
  org_id: string;
  canonical_domain: string;
  path_prefix: string;
}

export interface AppShellProps {
  user: SessionUser;
  /** Which workspace entry is highlighted. Defaults to the project area. */
  active?: "projects" | "connectors" | "ops";
  /** The project whose pages fill the sidebar. */
  site?: ShellSite | null;
  /** The project page being shown; drives which sections unfold under it. */
  page?: SitePageKey | "console" | "setup" | "theme";
  /** The organisation whose settings sections fill the sidebar. */
  org?: { id: string; name: string } | null;
  /** The section (tab) currently shown, after `resolveTab`. */
  section?: string;
  children: React.ReactNode;
}

/**
 * The signed-in frame. Server component; the only interactive piece is the
 * project switcher. The sidebar is: the project switcher, then Connectors
 * (for the current project) and Ops, then the current project's pages with
 * the open page's sections nested under it, then the organisation.
 */
export async function AppShell({ user, active = "projects", site, page, org, section, children }: AppShellProps) {
  const { workspace, context } = buildGroups({ user, active, site: site ?? null, page, org: org ?? null });
  const groups = [workspace, ...context];
  const projects: SwitcherProject[] = (await listSites(visibleOrgIds(user))).map((s) => ({ id: s.id, name: s.name, domain: s.canonical_domain, href: pageHrefForSite(s.id, page) }));
  const switcher = <ProjectSwitcher projects={projects} currentId={site?.id ?? null} />;
  return (
    <div className="flex min-h-screen">
      <aside className="bg-muted/40 hidden w-60 shrink-0 flex-col border-r px-3 py-5 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto">
        <Link href={"/app" as Route} className="px-2 text-sm font-semibold tracking-tight">AEO Platform</Link>
        <div className="mt-4">{switcher}</div>
        <nav className="mt-4 flex flex-col gap-6" aria-label="Main">
          {groups.map((g) => <SidebarGroup key={g.key} group={g} section={section} />)}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2 pt-6">
          <p className="text-muted-foreground truncate text-xs" title={user.email ?? undefined}>{user.name ?? user.email}</p>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start px-0"><LogOut /> Sign out</Button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b md:hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <Link href={"/app" as Route} className="shrink-0 text-sm font-semibold">AEO Platform</Link>
            <ProjectSwitcher projects={projects} currentId={site?.id ?? null} compact />
            <nav className="flex min-w-0 flex-1 justify-end gap-3 overflow-x-auto text-sm whitespace-nowrap" aria-label="Workspace">
              {workspace.items.map((n) => <Link key={n.key} href={n.href as Route} className={workspace.current === n.key ? "font-medium" : "text-muted-foreground"}>{n.label}</Link>)}
            </nav>
          </div>
          {context.map((g) => (
            <nav key={g.key} className="flex gap-1 overflow-x-auto border-t px-3 py-2 text-sm whitespace-nowrap" aria-label={g.title}>
              {g.items.map((n) => <Link key={n.key} href={n.href as Route} className={`shrink-0 rounded-md px-2 py-1 ${g.current === n.key ? "bg-background font-medium shadow-xs" : "text-muted-foreground"}`}>{n.label}</Link>)}
            </nav>
          ))}
        </header>
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

function SidebarGroup({ group, section }: { group: NavGroup; section?: string }) {
  return (
    <div>
      {group.title ? <p className="text-muted-foreground mb-1 px-2 text-[11px] font-medium tracking-wide uppercase">{group.title}</p> : null}
      <ul className="flex flex-col gap-0.5">
        {group.items.map((n) => {
          const current = group.current === n.key;
          const open = current && n.sections && n.sections.length > 0;
          return (
            <li key={n.key}>
              <Link
                href={n.href as Route}
                aria-current={current ? "page" : undefined}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${current ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:bg-background/60 hover:text-foreground"}`}
              >
                <n.icon className="size-4 shrink-0" /> <span className="truncate">{n.label}</span>
              </Link>
              {open ? (
                <ul className="mt-0.5 mb-1 ml-[15px] flex flex-col gap-0.5 border-l pl-3">
                  {n.sections!.map((s) => {
                    const on = section === s.value;
                    return (
                      <li key={s.value}>
                        <Link
                          href={sectionHref(n.href, s.value) as Route}
                          aria-current={on ? "location" : undefined}
                          className={`block rounded-md px-2 py-1 text-[13px] ${on ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {s.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function buildGroups({ user, active, site, page, org }: { user: SessionUser; active: "projects" | "connectors" | "ops"; site: ShellSite | null; page?: AppShellProps["page"]; org: { id: string; name: string } | null }): { workspace: NavGroup; context: NavGroup[] } {
  // Connectors follow the project: the entry always opens the current
  // project's connectors (or the redirect that picks one when none is open).
  const workspace: NavGroup = {
    key: "workspace",
    current: page === "connectors" ? "connectors" : active === "ops" ? "ops" : undefined,
    items: [
      { key: "connectors", href: site ? `/app/sites/${site.id}/connectors` : "/settings/connectors", label: "Connectors", icon: Plug },
      ...(user.isStaff ? [{ key: "ops", href: "/ops", label: "Ops", icon: ShieldCheck }] : []),
    ],
  };
  const groups: NavGroup[] = [];

  if (site) {
    const items: NavItem[] = SITE_PAGES.map((p) => ({
      key: p.key,
      href: sitePageHref(site.id, p),
      label: p.label,
      icon: PAGE_ICONS[p.key],
      sections: p.sections,
    }));
    if (canManage(user, site.org_id)) items.push({ key: "org", href: `/app/orgs/${site.org_id}`, label: "Organisation", icon: Building2 });
    groups.push({ key: "project", title: site.name, items, current: page && page !== "connectors" && page in PAGE_ICONS ? page : undefined });
  }

  if (org && !site) {
    groups.push({
      key: "org",
      title: org.name,
      current: "settings",
      items: [{ key: "settings", href: `/app/orgs/${org.id}`, label: "Organisation", icon: Building2, sections: ORG_SECTIONS }],
    });
  }

  if (user.isStaff && active === "ops") {
    const items: NavItem[] = [
      { key: "console", href: "/ops", label: "Console", icon: ShieldCheck, sections: OPS_SECTIONS },
      { key: "setup", href: "/ops/setup", label: "Setup checklist", icon: ListChecks },
    ];
    if (site && page === "theme") items.push({ key: "theme", href: `/ops/sites/${site.id}/theme`, label: `Theme · ${site.name}`, icon: Palette });
    groups.push({ key: "ops", title: "Ops", items, current: page === "console" || page === "setup" || page === "theme" ? page : undefined });
  }

  return { workspace, context: groups };
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
