"use server";

import { revalidatePath } from "next/cache";
import { canEdit, canManage, requireStaff, requireUser } from "@/lib/auth/session";
import { appDb } from "@/lib/db/app";
import { contentPublished } from "@/lib/inngest/client";
import { queueJob } from "@/lib/jobs/dispatch";
import { notifyOrg } from "@/lib/notify/org";
import { setAutonomyControl, type ControlSwitch } from "@/lib/ops/controls";
import type { ControlScope } from "@/lib/pipeline/guard";
import { setPageStatus } from "@/lib/pipeline/publish";
import { rollbackPage, RollbackRefusedError } from "@/lib/pipeline/republish";
import { isPushTarget, listPublishTargets } from "@/lib/publishing/targets";
import type { PageStatus } from "@/lib/render/published";
import type { ActionResult } from "./actions";
import { loadSite, setIndexingPaused } from "./store";

/**
 * Takedown and rollback. Per-page actions (noindex, retire, restore, roll
 * back) need an editor; pausing a whole site's indexing needs an owner or
 * admin; the kill switches are staff only. Each change is audited where it
 * is written and reported to the org (Slack alerts channel, owner email).
 * Bound arguments reach a server action from the browser as sent, so every
 * value is checked here again.
 */

const fail = (error: string): ActionResult => ({ ok: false, error });

const STATUS_VERB: Record<PageStatus, string> = { live: "restored to the index", noindex: "taken out of the index (noindex)", retired: "taken down (410 Gone)" };

async function guard(siteId: string, need: "edit" | "manage") {
  const user = await requireUser(`/app/sites/${siteId}/content`);
  const site = await loadSite(siteId);
  if (!site) return { user, site: null, error: "Project not found." };
  const allowed = need === "manage" ? canManage(user, site.org_id) : canEdit(user, site.org_id);
  return { user, site, error: allowed ? null : "You do not have access to this project." };
}

const refresh = (siteId: string) => {
  revalidatePath(`/app/sites/${siteId}/content`);
  revalidatePath(`/app/sites/${siteId}`);
  revalidatePath("/ops");
};

const validPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && path.length <= 1024;

/**
 * Copy what the page now serves to the auto-push targets (Webflow), as a
 * pipeline publish does: after a rollback the earlier version, after a
 * restore whatever was published behind the takedown. The push skips a copy
 * whose payload is unchanged. Returns a note when the push could not be
 * queued; the change on the proxy stands either way.
 */
async function pushCopies(siteId: string, orgId: string, page: { contentItemId: string; versionId: string; path: string; canonicalUrl: string }): Promise<string | null> {
  if (!(await listPublishTargets(siteId)).some((t) => isPushTarget(t, { onlyAuto: true }))) return null;
  const jobError = await queueJob(contentPublished.create({ ...page, siteId, orgId }), undefined, "push to publishing targets");
  return jobError ? `publishing targets were not updated: ${jobError}` : null;
}

const notes = (...parts: (string | null)[]) => parts.filter(Boolean).join("; ");

/** Noindex, retire or restore one page. Takes effect on the next request; CDNs may keep a copy up to 5 minutes. */
export async function setPageStatusAction(siteId: string, path: string, status: PageStatus, reason?: string): Promise<ActionResult> {
  if (status !== "live" && status !== "noindex" && status !== "retired") return fail("Unknown page status.");
  if (!validPath(path)) return fail("Page not found.");
  const { user, site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Project not found.");
  const change = await setPageStatus(siteId, path, status, { by: user.id, reason: reason ?? null });
  if (!change) return fail("Page not found.");
  refresh(siteId);
  if (!change.changed) return { ok: true, note: `already ${status}` };
  await notifyOrg(site.org_id, `${site.canonical_domain}${path} was ${STATUS_VERB[status]} by ${user.email}.${reason?.trim() ? `\nReason: ${reason.trim()}` : ""}`);
  const pushNote = status === "live" && change.contentItemId && change.versionId
    ? await pushCopies(siteId, site.org_id, { contentItemId: change.contentItemId, versionId: change.versionId, path, canonicalUrl: new URL(path, `https://${site.canonical_domain}`).toString() })
    : null;
  return { ok: true, note: notes("takes effect on the next request; a CDN may keep its copy for up to 5 minutes", pushNote) };
}

/** Republish the version a page replaced. No model call. */
export async function rollbackPageAction(siteId: string, path: string): Promise<ActionResult> {
  if (!validPath(path)) return fail("Page not found.");
  const { user, site, error } = await guard(siteId, "edit");
  if (!site || error) return fail(error ?? "Project not found.");
  try {
    const r = await rollbackPage(siteId, path, { by: user.id });
    refresh(siteId);
    const restored = r.statusBefore && r.statusBefore !== "live" ? ` It was ${r.statusBefore} and is live again.` : "";
    await notifyOrg(site.org_id, `${site.canonical_domain}${path} was rolled back to its previous version by ${user.email}.${restored}`);
    const pushNote = await pushCopies(siteId, site.org_id, { contentItemId: r.contentItemId, versionId: r.toVersionId, path: r.path, canonicalUrl: r.canonicalUrl });
    return { ok: true, note: notes(`live again at ${r.path}`, pushNote) };
  } catch (e) {
    if (e instanceof RollbackRefusedError) return fail(e.message);
    throw e;
  }
}

/** The site-wide takedown: every page noindex, listings empty, publishing held. */
export async function setIndexingPausedAction(siteId: string, paused: boolean): Promise<ActionResult> {
  const { user, site, error } = await guard(siteId, "manage");
  if (!site || error) return fail(error ?? "Project not found.");
  if (!(await setIndexingPaused(siteId, site.org_id, paused === true, user.id))) return fail("Project not found.");
  refresh(siteId);
  await notifyOrg(
    site.org_id,
    paused
      ? `Indexing paused for ${site.canonical_domain}${site.path_prefix} by ${user.email}: every page now serves noindex, the sitemap, feed and llms files list nothing, and publishing holds until it is resumed.`
      : `Indexing resumed for ${site.canonical_domain}${site.path_prefix} by ${user.email}.`,
  );
  return { ok: true };
}

// ── staff only ──────────────────────────────────────────────────────────────

/** Flip a kill switch for the platform (targetId null), an organisation or a site. */
export async function setAutonomyControlAction(scope: ControlScope, targetId: string | null, which: ControlSwitch, on: boolean): Promise<ActionResult> {
  const staff = await requireStaff();
  if (scope !== "global" && scope !== "org" && scope !== "site") return fail("Unknown scope.");
  if (which !== "publishing" && which !== "indexing") return fail("Unknown switch.");
  if (scope === "global" ? targetId !== null : typeof targetId !== "string") return fail("Unknown target.");
  if (scope === "org" && !(await appDb()`select 1 from app.organizations where id = ${targetId}`).length) return fail("Organisation not found.");
  let orgId: string | null;
  try {
    ({ orgId } = await setAutonomyControl({ scope, id: targetId }, which, on === true, { by: staff.id }));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  revalidatePath("/ops");
  if (scope === "site" && targetId) refresh(targetId);
  if (orgId) {
    const what = which === "publishing" ? "Publishing" : "Indexing";
    const site = scope === "site" && targetId ? await loadSite(targetId) : null;
    const where = site ? `${site.canonical_domain}${site.path_prefix}` : "every project in your organisation";
    await notifyOrg(orgId, `${what} ${on ? "paused" : "resumed"} by platform staff for ${where}.`);
  }
  return { ok: true };
}
