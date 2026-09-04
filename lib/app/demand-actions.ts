"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canEdit, requireUser } from "@/lib/auth/session";
import { demandMineRequested, inngest, serpTrackRequested } from "@/lib/inngest";
import type { ActionResult } from "./actions";
import { setQuestionTracking, trackTopQuestions, trackedQuestionIds } from "./demand";
import { loadSite } from "./store";

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(siteId: string) {
  const user = await requireUser(`/app/sites/${siteId}/demand`);
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Site not found." };
  return { user, site, error: canEdit(user, site.org_id) ? null : "You do not have permission for this project." };
}

const serpConfigured = () => !!(process.env.DATAFORSEO_LOGIN || process.env.SERPAPI_KEY);

const mineForm = z.object({
  siteId: z.guid(),
  seeds: z.string().min(2).max(5000),
  country: z.string().trim().length(2).default("us"),
  language: z.string().trim().min(2).max(5).default("en"),
  depth: z.coerce.number().int().min(1).max(3).default(2),
  trackTop: z.coerce.number().int().min(0).max(500).default(50),
  paa: z.coerce.boolean().default(true),
});

export async function mineDemandAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = mineForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { siteId, seeds, country, language, depth, trackTop, paa } = parsed.data;
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  if (!serpConfigured()) return fail("No SERP provider configured (DATAFORSEO_LOGIN / SERPAPI_KEY).");
  const list = [...new Set(seeds.split(/[\n,]/).map((s) => s.trim()).filter((s) => s.length >= 2))].slice(0, 50);
  if (list.length === 0) return fail("Add at least one seed term.");
  await inngest.send(demandMineRequested.create({ siteId, orgId: site.org_id, seeds: list, locale: { country: country.toLowerCase(), language: language.toLowerCase() }, depth, trackTop, paa }));
  return { ok: true };
}

export async function setTrackingAction(siteId: string, questionId: string, tier: "daily" | "weekly" | "monthly" | "none"): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  if (!(await setQuestionTracking(siteId, questionId, tier))) return fail("Question not found.");
  revalidatePath(`/app/sites/${siteId}/demand`);
  return { ok: true };
}

export async function trackTopAction(siteId: string, n: number, tier: "daily" | "weekly" | "monthly"): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  const count = await trackTopQuestions(siteId, Math.min(Math.max(n, 1), 500), tier);
  revalidatePath(`/app/sites/${siteId}/demand`);
  return { ok: true, error: count === 0 ? "No questions to track yet; mine a seed list first." : undefined };
}

export async function snapshotNowAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId);
  if (!site || error) return fail(error ?? "Site not found.");
  if (!serpConfigured()) return fail("No SERP provider configured (DATAFORSEO_LOGIN / SERPAPI_KEY).");
  const ids = await trackedQuestionIds(siteId, 200);
  if (ids.length === 0) return fail("Nothing is tracked yet.");
  await inngest.send(serpTrackRequested.create({ siteId, orgId: site.org_id, questionIds: ids }));
  return { ok: true };
}
