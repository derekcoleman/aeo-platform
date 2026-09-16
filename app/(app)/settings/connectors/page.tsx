import type { Route } from "next";
import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/app/nav";
import { listSites } from "@/lib/app/store";
import { requireUser, visibleOrgIds } from "@/lib/auth/session";

/**
 * Connectors are a settings tab per project. This path is kept because
 * OAuth callbacks and old links land here: it opens the most recent
 * project's connectors tab, carrying any query the callback attached
 * (connected=…, error=…).
 */
export default async function ConnectorsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser("/settings/connectors");
  const params = await searchParams;
  const sites = await listSites(visibleOrgIds(user));
  const url = new URL(settingsHref(sites[0]?.id, null, "connectors"), "http://x");
  for (const [k, v] of Object.entries(params)) if (typeof v === "string" && !url.searchParams.has(k)) url.searchParams.set(k, v);
  redirect(`${url.pathname}${url.search}` as Route);
}
