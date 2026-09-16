import type { Route } from "next";
import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/app/nav";

/**
 * Organisation settings moved to the settings hub (/settings). This path is
 * kept for old links, Stripe return URLs from before the move and the
 * `?tab=settings` spelling of the organisation tab.
 */
export default async function OrgRedirect({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ checkout?: string; tab?: string; site?: string }> }) {
  const { orgId } = await params;
  const { checkout, tab, site } = await searchParams;
  const url = new URL(settingsHref(site, orgId), "http://x");
  if (tab) url.searchParams.set("tab", tab === "settings" ? "organisation" : tab);
  if (checkout) url.searchParams.set("checkout", checkout);
  redirect(`${url.pathname}${url.search}` as Route);
}
