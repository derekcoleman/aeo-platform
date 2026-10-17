import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { ControlScope } from "@/lib/pipeline/guard";

/**
 * Staff kill switches (ops.autonomy_controls, migration 0020): one row per
 * scope — the whole platform, one organisation, one site — holding
 * publishing (every publish step waits, lib/pipeline/guard.ts) and/or
 * indexing (the scope's pages serve noindex and leave every listing; the
 * trigger copies the effective pause into content.site_render_config). A
 * row with both switches off is deleted; the audit log keeps its history.
 */

export interface AutonomyControl {
  id: string;
  scope: ControlScope;
  org_id: string | null;
  site_id: string | null;
  publishing_paused: boolean;
  indexing_paused: boolean;
  reason: string | null;
  set_by: string | null;
  set_at: string | Date;
}

export type ControlSwitch = "publishing" | "indexing";

export interface ControlTarget {
  scope: ControlScope;
  /** The org for an org control, the site for a site control, null for global. */
  id: string | null;
}

export async function listAutonomyControls(sql: postgres.Sql = appDb()): Promise<AutonomyControl[]> {
  return sql<AutonomyControl[]>`
    select id, scope::text as scope, org_id, site_id, publishing_paused, indexing_paused, reason, set_by, set_at
    from ops.autonomy_controls order by set_at desc`;
}

/** The control a page renders for a target, if any. */
export function controlFor(controls: AutonomyControl[], target: ControlTarget): AutonomyControl | null {
  return controls.find((c) => c.scope === target.scope && (target.scope === "global" || (target.scope === "org" ? c.org_id === target.id : c.site_id === target.id))) ?? null;
}

/**
 * Flip one switch on one scope, keeping the other as it is, and audit it.
 * Returns the org the change belongs to (null for a global control) so the
 * caller can tell that org.
 */
export async function setAutonomyControl(
  target: ControlTarget,
  which: ControlSwitch,
  on: boolean,
  opts: { by: string; reason?: string | null },
  sql: postgres.Sql = appDb(),
): Promise<{ orgId: string | null; control: Pick<AutonomyControl, "publishing_paused" | "indexing_paused"> }> {
  if ((target.scope === "global") !== (target.id === null)) throw new Error(`a ${target.scope} control ${target.scope === "global" ? "names no target" : "needs a target"}`);
  const orgId = target.scope === "org" ? target.id : null;
  const siteId = target.scope === "site" ? target.id : null;
  const reason = opts.reason?.trim().slice(0, 500) || null;
  return sql.begin(async (tx) => {
    // The site's org, so an org-scoped audit row and a site control agree.
    const owner = siteId ? (await tx<{ org_id: string }[]>`select org_id from app.sites where id = ${siteId}`)[0]?.org_id ?? null : orgId;
    if (siteId && !owner) throw new Error(`site ${siteId} not found`);
    const [current] = await tx<{ id: string; publishing_paused: boolean; indexing_paused: boolean }[]>`
      select id, publishing_paused, indexing_paused from ops.autonomy_controls
      where scope = ${target.scope} and org_id is not distinct from ${owner}::uuid and site_id is not distinct from ${siteId}::uuid
      for update`;
    const next = {
      publishing_paused: which === "publishing" ? on : (current?.publishing_paused ?? false),
      indexing_paused: which === "indexing" ? on : (current?.indexing_paused ?? false),
    };
    if (!next.publishing_paused && !next.indexing_paused) {
      if (current) await tx`delete from ops.autonomy_controls where id = ${current.id}`;
    } else if (current) {
      await tx`update ops.autonomy_controls set publishing_paused = ${next.publishing_paused}, indexing_paused = ${next.indexing_paused},
        reason = ${reason}, set_by = ${opts.by}, set_at = now() where id = ${current.id}`;
    } else {
      await tx`insert into ops.autonomy_controls (scope, org_id, site_id, publishing_paused, indexing_paused, reason, set_by)
        values (${target.scope}, ${orgId}, ${siteId}, ${next.publishing_paused}, ${next.indexing_paused}, ${reason}, ${opts.by})`;
    }
    await tx`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, before, after)
      values (${owner}, ${opts.by}, ${`ops.${which}_${on ? "paused" : "resumed"}`}, 'control', ${target.id ?? "global"},
              ${tx.json({ scope: target.scope, publishingPaused: current?.publishing_paused ?? false, indexingPaused: current?.indexing_paused ?? false } as never)},
              ${tx.json({ scope: target.scope, ...(siteId ? { siteId } : {}), publishingPaused: next.publishing_paused, indexingPaused: next.indexing_paused, reason } as never)})`;
    return { orgId: owner, control: next };
  }) as Promise<{ orgId: string | null; control: Pick<AutonomyControl, "publishing_paused" | "indexing_paused"> }>;
}
