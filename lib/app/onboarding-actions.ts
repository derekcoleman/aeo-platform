"use server";

import { revalidatePath } from "next/cache";
import { canEdit, requireUser } from "@/lib/auth/session";
import { appDb } from "@/lib/db/app";
import { demandMineRequested, inngest, siteOnboardingRequested } from "@/lib/inngest/client";
import { dispatch, queueJob } from "@/lib/jobs/dispatch";
import { inngestConfigured } from "@/lib/jobs/runner";
import { mineLocale } from "@/lib/demand/seeds";
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

const serpConfigured = () => !!(process.env.DATAFORSEO_LOGIN || process.env.SERPAPI_KEY);

/**
 * Add keywords (one or many) as topics. Each becomes a topic with itself as
 * the seed term, is remembered on the site, and, when a SERP provider and the
 * job runner are connected, starts mining questions for the new seeds right
 * away so the demand page fills in without another click.
 */
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
  revalidatePath(`/app/sites/${siteId}/demand`);
  if (created.length === 0) return fail(`Already tracked: ${skipped.join(", ")}.`);

  let note = `${created.length} topic${created.length === 1 ? "" : "s"}; now a seed for demand mining.`;
  if (serpConfigured() && inngestConfigured()) {
    const jobError = await queueJob(demandMineRequested.create({ siteId: site.id, orgId: site.org_id, seeds: created.slice(0, 50), locale: mineLocale(site.locale), depth: 1, trackTop: 50, paa: true }), undefined, "demand mining");
    note = jobError ? `${note} Mining did not start: ${jobError}` : `${note} Mining questions for ${created.length === 1 ? "it" : "them"} now.`;
  } else if (!serpConfigured()) {
    note = `${note} Add a SERP provider key to mine questions.`;
  }
  return { ok: true, note };
}

/** Form-shaped variant for the Strategy page. */
export async function addKeywordsFormAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return addKeywordsAction(String(form.get("siteId") ?? ""), String(form.get("keywords") ?? ""));
}
