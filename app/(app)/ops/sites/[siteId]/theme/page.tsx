import type { Route } from "next";
import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/app/nav";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A project's theme moved to Settings → Theme. */
export default async function ThemeRedirect({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  redirect(settingsHref(siteId, null, "theme") as Route);
}
