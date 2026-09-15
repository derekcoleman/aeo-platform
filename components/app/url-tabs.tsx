"use client";

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Tabs } from "@/components/ui/tabs";

interface UrlTabsProps {
  /** The section shown when the URL carries no `?tab=`. */
  defaultValue: string;
  /** Every valid section value; anything else in the URL falls back to the default. */
  values: string[];
  className?: string;
  children: React.ReactNode;
}

/**
 * A tab strip whose active tab lives in the URL (`?tab=`), so the sidebar
 * sections, the browser history and shared links all agree with the strip.
 * Switching a tab replaces the query without scrolling; the default section
 * keeps the plain URL.
 */
export function UrlTabs(props: UrlTabsProps) {
  return (
    <Suspense fallback={<Tabs defaultValue={props.defaultValue} className={props.className}>{props.children}</Tabs>}>
      <SyncedTabs {...props} />
    </Suspense>
  );
}

function SyncedTabs({ defaultValue, values, className, children }: UrlTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const requested = search.get("tab");
  const value = requested && values.includes(requested) ? requested : defaultValue;
  return (
    <Tabs
      value={value}
      className={className}
      onValueChange={(next) => {
        const params = new URLSearchParams(search.toString());
        if (next === defaultValue) params.delete("tab");
        else params.set("tab", next);
        const query = params.toString();
        router.replace(`${pathname}${query ? `?${query}` : ""}` as Route, { scroll: false });
      }}
    >
      {children}
    </Tabs>
  );
}
