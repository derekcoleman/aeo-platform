"use client";

import type { Route } from "next";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { sectionHref, type NavSection } from "@/lib/app/nav";

/**
 * One sidebar entry. An entry with sections gets a chevron that folds them
 * away; they start open on the current page and closed elsewhere, and the
 * fold is remembered for the life of the page. The icon arrives rendered
 * (server components cannot hand a component to a client one).
 */
export function SidebarItem({ href, label, icon, sections, current, section, compact = false }: { href: string; label: string; icon: React.ReactNode; sections?: NavSection[]; current: boolean; section?: string; /** The quieter footer style (Settings, Ops). */ compact?: boolean }) {
  const hasSections = !!sections && sections.length > 0;
  const [open, setOpen] = useState(current);
  const showSections = hasSections && current && open;
  return (
    <li>
      <div className={`flex items-center rounded-md ${current ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:bg-background/60 hover:text-foreground"}`}>
        <Link href={href as Route} aria-current={current ? "page" : undefined} className={`flex min-w-0 flex-1 items-center gap-2 px-2 ${compact ? "py-1 text-xs" : "py-1.5 text-sm"}`}>
          {icon} <span className="truncate">{label}</span>
        </Link>
        {hasSections && current ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? `Collapse ${label}` : `Expand ${label}`} aria-expanded={open} className="text-muted-foreground hover:text-foreground mr-1 rounded p-1">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : null}
      </div>
      {showSections ? (
        <ul className="mt-0.5 mb-1 ml-[15px] flex flex-col gap-0.5 border-l pl-3">
          {sections!.map((s) => {
            const on = section === s.value;
            return (
              <li key={s.value}>
                <Link href={sectionHref(href, s.value) as Route} aria-current={on ? "location" : undefined} className={`block rounded-md px-2 py-1 text-[13px] ${on ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {s.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
