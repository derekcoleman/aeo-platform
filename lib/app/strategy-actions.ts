"use server";

import { queueJob } from "@/lib/jobs/dispatch";

import { LLM_NOT_CONFIGURED, llmConfigured } from "@/lib/ai/model";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canEdit, canManage, requireUser } from "@/lib/auth/session";
import { connectorContext, createConnection, setFeature } from "@/lib/connectors";
import { PROFOUND_FEATURE } from "@/lib/connectors/profound";
import { PROFOUND_DEFAULT_BASE, ProfoundApi, ProfoundApiError, ProfoundDiscoveryError, type DiscoveryAttempt } from "@/lib/connectors/profound/api";
import { appDb } from "@/lib/db/app";
import { connectorSyncRequested, contentPipelineRequested, strategyCompetitorsAnalyzeRequested } from "@/lib/inngest";
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
    if (!llmConfigured()) return { ok: true, id, error: `Queued, but the pipeline cannot draft yet. ${LLM_NOT_CONFIGURED}` };
    const jobError = await queueJob(contentPipelineRequested.create({ opportunityId: id, siteId, orgId: site.org_id, note: note || null }), undefined, "pipeline");
    if (jobError) return { ok: true, id, error: `Created, but not started. ${jobError}` };
  }
  refresh(siteId);
  return { ok: true, id };
}

export async function analyzeCompetitorsAction(siteId: string, topicId?: string | null): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const jobError = await queueJob(strategyCompetitorsAnalyzeRequested.create({ siteId, orgId: site.org_id, topicId: topicId ?? null }));
  if (jobError) return fail(jobError);
  return { ok: true };
}

// ── Profound API connection ─────────────────────────────────────────────────

const apiPath = z.string().trim().max(200).regex(/^(\/[^\s?#]*)?$/, "Endpoint paths start with /").optional().default("");

const profoundForm = z.object({
  siteId: z.guid(),
  apiKey: z.string().trim().min(8).max(500),
  categoryId: z.string().trim().max(200).optional().default(""),
  baseUrl: z.string().trim().url().optional().or(z.literal("")).default(""),
  categoriesPath: apiPath,
  answersPath: apiPath,
  citationsPath: apiPath,
});

const describeAttempts = (attempts: DiscoveryAttempt[]) => attempts.map((a) => `${a.url} → ${a.status ?? "no response"}`).join("; ");

/**
 * Connect a Profound API key to a site. The category list endpoint is
 * discovered (Profound has moved it), and when it cannot be found at all
 * but a category id was given, one day of the answers report proves the
 * key and category instead. Whatever answered is stored on the connection
 * so the daily sync does not repeat the search.
 */
export async function connectProfoundAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = profoundForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input.");
  const { siteId, apiKey, categoryId, baseUrl, categoriesPath, answersPath, citationsPath } = parsed.data;
  const { user, site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Site not found.");
  const endpoints = { ...(categoriesPath ? { categories: categoriesPath } : {}), ...(answersPath ? { answers: answersPath } : {}), ...(citationsPath ? { citations: citationsPath } : {}) };
  const api = new ProfoundApi({ apiKey, baseUrl: baseUrl || undefined, endpoints });
  const ctx = connectorContext();

  let chosen: { id: string; name: string } | undefined;
  let resolvedBase = api.baseUrl;
  let resolvedEndpoints: Record<string, string> = { ...endpoints };
  let note: string | undefined;
  let discovery: Awaited<ReturnType<ProfoundApi["discoverCategories"]>> | null = null;
  try {
    discovery = await api.discoverCategories();
  } catch (e) {
    if (e instanceof ProfoundApiError) return fail(`Profound rejected the key (${e.status}) at ${e.path}: ${e.message}. The endpoint exists, so check the key and the plan.`);
    if (!(e instanceof ProfoundDiscoveryError)) return fail(`Could not reach Profound: ${e instanceof Error ? e.message : String(e)}`);
    if (!categoryId) {
      return fail(
        `Profound answered, but no category-list endpoint was found. That is a path problem, not the key: tried ${describeAttempts(e.attempts)}. ` +
          "Open Profound's API reference, put the current paths under Advanced, or enter your category id and we will verify it with a one-day report call instead.",
      );
    }
    try {
      const { rows } = await api.verifyReport(categoryId, ctx.now().toISOString().slice(0, 10));
      chosen = { id: categoryId, name: categoryId };
      note = `Category list endpoint not found (tried ${e.attempts.length} paths); verified with a one-day answers report instead (${rows} row${rows === 1 ? "" : "s"}).`;
    } catch (re) {
      if (re instanceof ProfoundApiError) return fail(`No category-list endpoint answered (tried ${describeAttempts(e.attempts)}) and the answers report at ${re.path} failed too (${re.status}): ${re.message}. Copy the current paths from Profound's API reference into Advanced.`);
      return fail(`Could not reach Profound: ${re instanceof Error ? re.message : String(re)}`);
    }
  }
  if (discovery) {
    resolvedBase = discovery.baseUrl;
    resolvedEndpoints = { ...resolvedEndpoints, categories: discovery.path };
    const { categories } = discovery;
    if (categories.length === 0) return fail(`The key works (${discovery.baseUrl}${discovery.path} answered) but Profound returned no categories. Check the plan, or enter a category id to verify with a report call.`);
    chosen = categoryId ? categories.find((c) => c.id === categoryId) : categories.length === 1 ? categories[0] : undefined;
    if (!chosen) return fail(`Choose a category id: ${categories.slice(0, 12).map((c) => `${c.id} (${c.name})`).join(", ")}`);
  }
  if (!chosen) return fail("Could not determine a Profound category.");

  const conn = await createConnection(
    {
      orgId: site.org_id,
      siteId,
      provider: "profound",
      secret: apiKey,
      config: {
        mode: "api",
        plan: "enterprise",
        categoryId: chosen.id,
        categoryName: chosen.name,
        ...(resolvedBase !== PROFOUND_DEFAULT_BASE ? { baseUrl: resolvedBase } : {}),
        ...(Object.keys(resolvedEndpoints).length ? { endpoints: resolvedEndpoints } : {}),
        backfillDays: 90,
      },
      externalAccountId: chosen.id,
      externalAccountName: chosen.name,
      status: "active",
      createdBy: user.id,
    },
    ctx.secrets,
    ctx.sql,
  );
  await setFeature(site.org_id, PROFOUND_FEATURE, true);
  refresh(siteId);
  // The connection is saved whatever happens next; a queue failure is a note, not a failure.
  const jobError = await queueJob(connectorSyncRequested.create({ connectionId: conn.id, orgId: site.org_id, kind: "backfill" }), undefined, "Profound backfill");
  if (jobError) return { ok: true, id: conn.id, note: [note, `Saved as "${chosen.name}", but the 90-day backfill did not start and the daily sync will not run until the job runner is connected: ${jobError}`].filter(Boolean).join(" ") };
  return { ok: true, id: conn.id, note: [note, "The 90-day backfill is queued."].filter(Boolean).join(" ") };
}
