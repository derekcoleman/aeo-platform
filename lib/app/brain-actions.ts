"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, canEdit, canManage } from "@/lib/auth/session";
import { listEntities, upsertEntity } from "@/lib/context/entities";
import { rejectFact, verifyFact } from "@/lib/context/facts";
import { activateManifest, draftManifestFromFacts, insertManifest, manifestDocSchema } from "@/lib/context/manifest";
import { entityTypeSchema } from "@/lib/context/types";
import { appDb } from "@/lib/db/app";
import { contextFactsExtractRequested, contextIngestRequested, contextSignalsScanRequested, inngest } from "@/lib/inngest";
import { modelFor } from "@/lib/pipeline/model";
import type { ActionResult } from "./actions";
import { loadSite } from "./store";

/**
 * Server actions for the Brain page. Every one re-checks the session and the
 * caller's role on the site's org; facts and entities are org-scoped, so the
 * site is only the door the user came in through.
 */

const fail = (error: string): ActionResult => ({ ok: false, error });

async function guard(siteId: string, level: "edit" | "manage") {
  const user = await requireUser(`/app/sites/${siteId}/brain`);
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Site not found." };
  const allowed = level === "manage" ? canManage(user, site.org_id) : canEdit(user, site.org_id);
  return { user, site, error: allowed ? null : "You do not have permission for this organisation." };
}

const refresh = (siteId: string) => revalidatePath(`/app/sites/${siteId}/brain`);

export async function verifyFactAction(siteId: string, factId: string): Promise<ActionResult> {
  const { user, site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const ok = await verifyFact(site.org_id, factId, user.id);
  if (!ok) return fail("This fact is no longer a candidate.");
  refresh(siteId);
  return { ok: true };
}

export async function rejectFactAction(siteId: string, factId: string, reason?: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const ok = await rejectFact(site.org_id, factId, reason?.trim() || null);
  if (!ok) return fail("This fact is no longer a candidate.");
  refresh(siteId);
  return { ok: true };
}

const entityForm = z.object({
  siteId: z.guid(),
  name: z.string().trim().min(1).max(120),
  type: entityTypeSchema,
  aliases: z.string().max(1000).default(""),
  description: z.string().max(600).default(""),
  wikidataId: z.string().max(40).default(""),
});

export async function upsertEntityAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = entityForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid entity.");
  const { siteId, name, type, aliases, description, wikidataId } = parsed.data;
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  const row = await upsertEntity(site.org_id, {
    name,
    type,
    aliases: aliases.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    description: description.trim() || null,
    wikidataId: /^Q\d+$/.test(wikidataId.trim()) ? wikidataId.trim() : null,
  });
  refresh(siteId);
  return { ok: true, id: row.id };
}

export async function ingestNowAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  await inngest.send(contextIngestRequested.create({ orgId: site.org_id }));
  return { ok: true };
}

export async function extractFactsAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  if (!process.env.ANTHROPIC_API_KEY) return fail("ANTHROPIC_API_KEY is not set; fact extraction needs a model.");
  await inngest.send(contextFactsExtractRequested.create({ orgId: site.org_id, siteId }));
  return { ok: true };
}

export async function scanSignalsAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  await inngest.send(contextSignalsScanRequested.create({ siteId, orgId: site.org_id }));
  return { ok: true };
}

export async function dismissSignalAction(siteId: string, signalId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Site not found.");
  await appDb()`update context.signals set status = 'dismissed' where id = ${signalId} and org_id = ${site.org_id}`;
  refresh(siteId);
  return { ok: true };
}

export async function draftManifestAction(siteId: string): Promise<ActionResult> {
  const { site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Site not found.");
  if (!process.env.ANTHROPIC_API_KEY) return fail("ANTHROPIC_API_KEY is not set; drafting needs a model.");
  const entities = await listEntities(site.org_id, appDb(), ["brand"]);
  const brand = entities[0]?.name ?? site.name;
  const row = await draftManifestFromFacts(modelFor("context.manifest.draft"), { orgId: site.org_id, siteId, brand: { name: brand, domain: site.canonical_domain } });
  if (!row) return fail("Fewer than three verified facts. Verify some facts first; a manifesto invented from nothing is worse than none.");
  refresh(siteId);
  return { ok: true, id: row.id };
}

export async function saveManifestAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const siteId = String(form.get("siteId") ?? "");
  const raw = String(form.get("doc") ?? "");
  const { user, site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Site not found.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("The manifest must be valid JSON.");
  }
  const doc = manifestDocSchema.safeParse(parsed);
  if (!doc.success) return fail(`Invalid manifest: ${doc.error.issues[0]?.path.join(".")} ${doc.error.issues[0]?.message}`);
  const row = await insertManifest({ orgId: site.org_id, siteId, doc: doc.data, source: { kind: "manual", by: user.id }, createdBy: user.id });
  refresh(siteId);
  return { ok: true, id: row.id };
}

export async function activateManifestAction(siteId: string, manifestId: string): Promise<ActionResult> {
  const { user, site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Site not found.");
  const row = await activateManifest(site.org_id, manifestId);
  if (!row) return fail("Manifest not found.");
  await appDb()`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
    values (${site.org_id}, ${user.id}, 'manifest.activate', 'brand_manifest', ${manifestId}, ${appDb().json({ version: row.version } as never)})`;
  refresh(siteId);
  return { ok: true };
}
