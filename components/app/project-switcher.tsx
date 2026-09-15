"use client";

import type { Route } from "next";
import Link from "next/link";
import { Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * The project switcher at the top of the sidebar. Picking a project keeps
 * the page you are on (Strategy stays Strategy, Connectors stays
 * Connectors) so switching between two projects to compare is one click.
 */

export interface SwitcherProject {
  id: string;
  name: string;
  domain: string;
  /** Where this project's copy of the current page lives. */
  href: string;
}

export function ProjectSwitcher({ projects, currentId, compact = false }: { projects: SwitcherProject[]; currentId: string | null; compact?: boolean }) {
  const current = projects.find((p) => p.id === currentId) ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`hover:bg-background/60 flex w-full items-center gap-2 rounded-md border px-2 text-left ${compact ? "h-8 max-w-48 text-xs" : "py-1.5 text-sm"}`}
          aria-label="Switch project"
        >
          <LayoutGrid className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{current ? current.name : "Projects"}</span>
            {current && !compact ? <span className="text-muted-foreground block truncate text-[11px]">{current.domain}</span> : null}
          </span>
          <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        {projects.length === 0 ? <DropdownMenuItem disabled>No projects yet</DropdownMenuItem> : null}
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} asChild>
            <Link href={p.href as Route} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.name}</span>
                <span className="text-muted-foreground block truncate text-[11px]">{p.domain}</span>
              </span>
              {p.id === currentId ? <Check className="size-4 shrink-0" /> : null}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={"/app" as Route} className="flex items-center gap-2"><LayoutGrid className="size-4" /> All projects</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={"/app?new=1" as Route} className="flex items-center gap-2"><Plus className="size-4" /> New project</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
