"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canEdit, canManage, requireUser } from "@/lib/auth/session";
import { connectorContext, createConnection, setFeature } from "@/lib/connectors";
import { PROFOUND_FEATURE } from "@/lib/connectors/profound";
import { ProfoundApi, ProfoundApiError } from "@/lib/connectors/profound/api";
import { appDb } from "@/lib/db/app";
import { connectorSyncRequested, contentPipelineRequested, inngest, strategyCompetitorsAnalyzeRequested } from "@/lib/inngest";
import { createManualOpportunity } from "@/lib/pipeline/opportunities";
import { addManualPrompt, assignQuestionsToTopics, createTopic, setQuestionFlags, topicInputSchema, updateTopic } from "@/lib/strategy/topics";
import type { ActionResult } from "./actions";
import { loadSite } from "./store";

/**
 * Server actions for the Strategy page: topics, prompt control, manual
 * content requests, competitor analysis and the Profound API connection.
 */

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(siteId: string, level: "edit" | "manage") {
  const user = await requireUser(`/app/sites/${siteId}/strategy`);
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Site not found." };
  const allowed = level === "manage" ? canManage(user, site.org_id) : canEdit(user, site.org_id);
  return { user, site, error: allowed ? null : "You do not have permission for this project." };
}

const refresh = (siteId: string) => {
  revalidatePath(`/app/sites/${siteId}/strategy`);
  revalidatePath(`/app/sites/${siteId}/demand`);
  revalidatePath(`/app/sites/${siteId}`);
};

export async function saveTopicAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const siteId = String(form.get("siteId") ?? "");
  const topicId = String(form.get("topicId") ?? "");
  const parsed = topicInputSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid topic.");
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const row = topicId ? await updateTopic(siteId, topicId, parsed.data) : await createTopic(siteId, parsed.data);
  if (!row) return fail("Topic not found.");
  await assignQuestionsToTopics(siteId).catch(() => undefined);
  refresh(siteId);
  return { ok: true, id: row.id };
}

export async function setTopicStatusAction(siteId: string, topicId: string, status: "active" | "paused" | "archived"): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  await appDb()`update measure.topics set status = ${status}, updated_at = now() where site_id = ${siteId} and id = ${topicId}`;
  refresh(siteId);
  return { ok: true };
}

const promptForm = z.object({
  siteId: z.guid(),
  topicId: z.string().optional().default(""),
  text: z.string().trim().min(3).max(300),
  tier: z.enum(["daily", "weekly", "monthly", "none"]).default("weekly"),
});

export async function addPromptAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = promptForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid prompt.");
  const { siteId, topicId, text, tier } = parsed.data;
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length >= 3).slice(0, 50);
  let added = 0;
  for (const line of lines) {
    await addManualPrompt(siteId, { text: line, topicId: topicId || null, tier });
    added++;
  }
  refresh(siteId);
  return { ok: true, error: added > 1 ? `${added} prompts added` : undefined };
}

export async function setQuestionFlagAction(siteId: string, questionId: string, flags: { excluded?: boolean; pinned?: boolean; topicId?: string | null }): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  if (!(await setQuestionFlags(siteId, questionId, flags))) return fail("Question not found.");
  refresh(siteId);
  return { ok: true };
}

export async function assignTopicsAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const r = await assignQuestionsToTopics(siteId, { reassign: true });
  refresh(siteId);
  return { ok: true, error: `${r.assigned} of ${r.considered} questions (re)assigned` };
}

const contentForm = z.object({
  siteId: z.guid(),
  topicId: z.string().optional().default(""),
  questionId: z.string().optional().default(""),
  title: z.string().trim().min(5).max(300),
  format: z.enum(["comparison", "howto", "guide", "listicle", "faq", ""]).default(""),
  note: z.string().trim().max(1000).optional().default(""),
  startNow: z.string().optional().default(""),
});

/** "Write about this now": a manual opportunity, optionally started through the pipeline immediately. */
export async function createContentAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = contentForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid request.");
  const { siteId, topicId, questionId, title, format, note, startNow } = parsed.data;
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const { id } = await createManualOpportunity(siteId, { title, topicId: topicId || null, questionId: questionId || null, format: (format || null) as never, note: note || null });
  if (startNow) {
    if (!process.env.ANTHROPIC_API_KEY) return { ok: true, id, error: "Queued, but ANTHROPIC_API_KEY is not set so the pipeline cannot draft yet." };
    await inngest.send(contentPipelineRequested.create({ opportunityId: id, siteId, orgId: site.org_id, note: note || null }));
  }
  refresh(siteId);
  return { ok: true, id };
}

export async function analyzeCompetitorsAction(siteId: string, topicId?: string | null): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  await inngest.send(strategyCompetitorsAnalyzeRequested.create({ siteId, orgId: site.org_id, topicId: topicId ?? null }));
  return { ok: true };
}

// ── Profound API connection ─────────────────────────────────────────────────

const profoundForm = z.object({
  siteId: z.guid(),
  apiKey: z.string().trim().min(8).max(500),
  categoryId: z.string().trim().max(200).optional().default(""),
  baseUrl: z.string().trim().url().optional().or(z.literal("")).default(""),
});

export async function connectProfoundAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = profoundForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { siteId, apiKey, categoryId, baseUrl } = parsed.data;
  const { user, site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Site not found.");
  const api = new ProfoundApi({ apiKey, baseUrl: baseUrl || undefined });
  let categories;
  try {
    categories = await api.categories();
  } catch (e) {
    return fail(e instanceof ProfoundApiError ? `Profound rejected the key (${e.status}): ${e.message}` : `Could not reach Profound: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (categories.length === 0) return fail("The key works but Profound returned no categories. Check the plan and the base URL / endpoint paths.");
  const chosen = categoryId ? categories.find((c) => c.id === categoryId) : categories.length === 1 ? categories[0] : undefined;
  if (!chosen) return fail(`Choose a category id: ${categories.slice(0, 12).map((c) => `${c.id} (${c.name})`).join(", ")}`);
  const ctx = connectorContext();
  const conn = await createConnection(
    {
      orgId: site.org_id,
      siteId,
      provider: "profound",
      secret: apiKey,
      config: { mode: "api", plan: "enterprise", categoryId: chosen.id, categoryName: chosen.name, ...(baseUrl ? { baseUrl } : {}), backfillDays: 90 },
      externalAccountId: chosen.id,
      externalAccountName: chosen.name,
      status: "active",
      createdBy: user.id,
    },
    ctx.secrets,
    ctx.sql,
  );
  await setFeature(site.org_id, PROFOUND_FEATURE, true);
  await inngest.send(connectorSyncRequested.create({ connectionId: conn.id, orgId: site.org_id, kind: "backfill" }));
  refresh(siteId);
  return { ok: true, id: conn.id };
}
