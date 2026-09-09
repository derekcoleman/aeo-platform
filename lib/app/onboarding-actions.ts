"use server";

import { revalidatePath } from "next/cache";
import { canEdit, requireUser } from "@/lib/auth/session";
import { appDb } from "@/lib/db/app";
import { inngest, siteOnboardingRequested } from "@/lib/inngest/client";
import { dispatch } from "@/lib/jobs/dispatch";
import { keywordsToTopics, parseKeywords } from "@/lib/onboarding/profile";
import { runSiteOnboarding, setProfileStatus } from "@/lib/onboarding/run";
import type { ActionResult } from "./actions";
import { loadSite } from "./store";

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(siteId: string) {
  const user = await requireUser();
  const site = await loadSite(siteId);
  if (!site) return { site: null, error: "Project not found." };
  return { site, error: canEdit(user, site.org_id) ? null : "You do not have access to this project." };
}

/** Re-crawl the site and rebuild the business profile (also the retry after a failure). */
export async function refreshProfileAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Project not found.");
  if (site.profile_status === "running") return fail("A crawl is already running.");
  await setProfileStatus(site.id, "queued");
  await dispatch(
    () => inngest.send(siteOnboardingRequested.create({ siteId: site.id, orgId: site.org_id })),
    () => runSiteOnboarding({ siteId: site.id, orgId: site.org_id }),
    "site re-crawl",
  );
  revalidatePath(`/app/sites/${siteId}`);
  return { ok: true };
}

/** Add keywords (one or many) as topics; also remembered on the site for demand mining. */
export async function addKeywordsAction(siteId: string, raw: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Project not found.");
  const keywords = parseKeywords(raw);
  if (keywords.length === 0) return fail("Enter at least one keyword.");
  const sql = appDb();
  const { created, skipped } = await keywordsToTopics(site.id, keywords, sql);
  const merged = [...new Set([...site.keywords, ...keywords].map((k) => k.trim()))].slice(0, 100);
  await sql`update app.sites set keywords = ${sql.array(merged)} where id = ${site.id} and org_id = ${site.org_id}`;
  revalidatePath(`/app/sites/${siteId}`);
  revalidatePath(`/app/sites/${siteId}/strategy`);
  if (created.length === 0) return fail(`Already tracked: ${skipped.join(", ")}.`);
  return { ok: true };
}

/** Form-shaped variant for the Strategy page. */
export async function addKeywordsFormAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return addKeywordsAction(String(form.get("siteId") ?? ""), String(form.get("keywords") ?? ""));
}
