import type { Route } from "next";
import { redirect } from "next/navigation";
import { listSites } from "@/lib/app/store";
import { requireUser, visibleOrgIds } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Connectors live under a project now (/app/sites/{id}/connectors). This
 * path is kept because OAuth callbacks and old links land here: it sends the
 * user to their most recent project's connectors, carrying any query the
 * callback attached (connected=…, error=…).
 */
export default async function ConnectorsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser("/settings/connectors");
  const params = await searchParams;
  const sites = await listSites(visibleOrgIds(user));
  const target = sites[0] ? `/app/sites/${sites[0].id}/connectors` : "/app";
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  redirect(`${target}${query ? `?${query}` : ""}` as Route);
}
