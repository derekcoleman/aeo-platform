"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-fetches the server-rendered page on an interval while `active`, so a
 * status that changes in a background job (a crawl, a mining run) shows up
 * without a manual reload. Stops after `maxMs` so a stuck job cannot poll
 * forever, and pauses while the tab is hidden.
 */
export function LiveRefresh({ active, intervalMs = 4000, maxMs = 10 * 60 * 1000 }: { active: boolean; intervalMs?: number; maxMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (Date.now() - startedAt > maxMs) {
        clearInterval(id);
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, maxMs, router]);
  return null;
}
