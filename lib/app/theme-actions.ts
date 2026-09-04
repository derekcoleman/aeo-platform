"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/session";
import { appDb } from "@/lib/db/app";
import { safeFetch } from "@/lib/fetch";
import { extractTheme } from "@/lib/render/extract-theme";
import type { SiteTheme } from "@/lib/render/theme";
import type { ActionResult } from "./actions";
import { normaliseTheme } from "./preview";
import { loadSite } from "./store";

/**
 * Staff-only theme edits. Data-driven only: tokens, sanitised header/footer
 * fragments and custom CSS. No tenant JavaScript, ever. Every save is audited.
 */

const fail = (error: string): ActionResult => ({ ok: false, error });

async function saveTheme(siteId: string, theme: SiteTheme, actorId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const clean = normaliseTheme(theme);
  const sql = appDb();
  await sql.begin(async (tx) => {
    await tx`update content.site_render_config set theme = ${tx.json(clean as never)}, updated_at = now() where site_id = ${siteId}`;
    await tx`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
      values ((select org_id from app.sites where id = ${siteId}), ${actorId}, ${action}, 'site_theme', ${siteId}, ${tx.json({ ...detail, tokens: Object.keys(clean.tokens).length } as never)})`;
  });
}

export async function saveThemeAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const user = await requireStaff();
  const siteId = String(form.get("siteId") ?? "");
  const site = await loadSite(siteId);
  if (!site) return fail("Site not found.");
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(String(form.get("tokens") || "{}")) as Record<string, unknown>;
  } catch {
    return fail("Tokens must be a JSON object of token → value.");
  }
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return fail("Tokens must be a JSON object.");
  const theme: SiteTheme = {
    tokens: Object.fromEntries(Object.entries(tokens).filter(([, v]) => typeof v === "string")) as SiteTheme["tokens"],
    headerHtml: String(form.get("headerHtml") ?? "") || null,
    footerHtml: String(form.get("footerHtml") ?? "") || null,
    customCss: String(form.get("customCss") ?? "") || null,
  };
  await saveTheme(siteId, theme, user.id, "theme.save", { source: "editor" });
  revalidatePath(`/ops/sites/${siteId}/theme`);
  return { ok: true };
}

/** Fetch the customer's homepage and derive a first-pass theme. Overwrites the saved theme; ops refines it after. */
export async function extractThemeAction(siteId: string): Promise<ActionResult> {
  const user = await requireStaff();
  const site = await loadSite(siteId);
  if (!site) return fail("Site not found.");
  const url = `https://${site.canonical_domain}/`;
  let html: string;
  try {
    const res = await safeFetch(url, { timeoutMs: 12_000, maxBytes: 2 * 1024 * 1024, maxRetries: 0 });
    if (!res.ok) return fail(`Homepage returned ${res.status}.`);
    html = res.body;
  } catch (err) {
    return fail(`Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const extracted = extractTheme(html, url);
  if (Object.keys(extracted.theme.tokens).length === 0 && !extracted.theme.headerHtml) return fail("Nothing usable found on the homepage; it is probably fully client-rendered. Set the tokens by hand.");
  await saveTheme(siteId, extracted.theme, user.id, "theme.extract", { source: url, evidence: extracted.evidence, logo: extracted.logo });
  if (extracted.logo) {
    await appDb()`update content.site_render_config set organization = organization || ${appDb().json({ logo: extracted.logo } as never)} where site_id = ${siteId}`;
  }
  revalidatePath(`/ops/sites/${siteId}/theme`);
  return { ok: true };
}
