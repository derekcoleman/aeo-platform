import type { Route } from "next";
import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/app/nav";

/** The deployment checklist moved to Settings → Deployment. */
export default async function SetupRedirect({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site } = await searchParams;
  redirect(settingsHref(site, null, "deployment") as Route);
}
