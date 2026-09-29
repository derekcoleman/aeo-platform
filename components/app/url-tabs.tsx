"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Tabs } from "@/components/ui/tabs";
import { withTab } from "@/lib/app/nav";

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
 *
 * Every section's content is already in the page, so a click switches the
 * strip at once and only rewrites the query string in place (the browser's
 * own `history.replaceState`, which Next mirrors into `useSearchParams`).
 * It never asks the server for the page again: pages such as Strategy take
 * seconds to render, and routing the click through a server round trip made
 * the strip look dead until it returned. The URL always names the section,
 * the default included, so anything reading the query (the sidebar) agrees
 * with what is shown.
 */
export function UrlTabs(props: UrlTabsProps) {
  return (
    <Suspense fallback={<Tabs defaultValue={props.defaultValue} className={props.className}>{props.children}</Tabs>}>
      <SyncedTabs {...props} />
    </Suspense>
  );
}

function SyncedTabs({ defaultValue, values, className, children }: UrlTabsProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const requested = search.get("tab");
  const fromUrl = requested && values.includes(requested) ? requested : defaultValue;
  // Local state so the strip moves on the click itself; the URL follows, and
  // a URL change from elsewhere (a sidebar link, back/forward) follows here.
  const [value, setValue] = useState(fromUrl);
  useEffect(() => setValue(fromUrl), [fromUrl]);
  return (
    <Tabs
      value={value}
      className={className}
      onValueChange={(next) => {
        setValue(next);
        if (typeof window === "undefined") return;
        const query = withTab(search.toString(), next);
        window.history.replaceState(window.history.state, "", `${pathname}?${query}`);
      }}
    >
      {children}
    </Tabs>
  );
}
