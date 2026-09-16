import type { Route } from "next";
import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/app/nav";

/** Connectors moved to Settings → Connectors; old links and OAuth return URLs land here with their notice query. */
export default async function SiteConnectorsRedirect({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { siteId } = await params;
  const query = await searchParams;
  const url = new URL(settingsHref(siteId, null, "connectors"), "http://x");
  for (const [k, v] of Object.entries(query)) if (typeof v === "string" && !url.searchParams.has(k)) url.searchParams.set(k, v);
  redirect(`${url.pathname}${url.search}` as Route);
}
