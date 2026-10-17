import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { GateStep } from "./gate";

/**
 * The kill switch every publish step passes through. Publishing holds while
 * the site is paused or disabled, while staff have paused publishing for
 * the platform, the organisation or the site (ops.autonomy_controls), and
 * while the site's indexing is paused: nothing new goes live during a
 * takedown. A held step sleeps an hour and asks again, for up to three days,
 * then the run fails and says why.
 */

export const PUBLISH_HOLD = "1h";
/**
 * 72 one-hour holds: a pause lifted within three days lets the run finish on
 * its own. At most 145 steps, which with every gate of a pipeline run at its
 * cap still fits Inngest's 1000-step limit.
 */
export const PUBLISH_MAX_HOLDS = 72;

export type ControlScope = "global" | "org" | "site";

export interface ControlRow {
  scope: ControlScope;
  publishing_paused: boolean;
  indexing_paused: boolean;
  reason: string | null;
}

export interface GuardState {
  site: { status: string; indexing_paused: boolean } | null;
  /** The controls covering the site: the global one, its organisation's, its own. */
  controls: ControlRow[];
}

export type PublishVerdict = { ok: true } | { ok: false; reason: string };

const SCOPE_LABEL: Record<ControlScope, string> = { global: "on the whole platform", org: "for this organisation", site: "for this project" };
const SCOPE_ORDER: ControlScope[] = ["global", "org", "site"];

/** Pure: the first reason publishing must hold, widest scope first. */
export function guardVerdict(state: GuardState): PublishVerdict {
  if (!state.site) return { ok: false, reason: "the project no longer exists" };
  if (state.site.status === "paused" || state.site.status === "disabled") return { ok: false, reason: `the project is ${state.site.status}` };
  const controls = [...state.controls].sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope));
  for (const c of controls) {
    if (c.publishing_paused) return { ok: false, reason: `staff paused publishing ${SCOPE_LABEL[c.scope]}${c.reason ? `: ${c.reason}` : ""}` };
  }
  for (const c of controls) {
    if (c.indexing_paused) return { ok: false, reason: `staff paused indexing ${SCOPE_LABEL[c.scope]}${c.reason ? `: ${c.reason}` : ""}` };
  }
  if (state.site.indexing_paused) return { ok: false, reason: "indexing is paused for this project" };
  return { ok: true };
}

export async function loadGuardState(siteId: string, sql: postgres.Sql = appDb()): Promise<GuardState> {
  const [site] = await sql<{ org_id: string; status: string; indexing_paused: boolean }[]>`
    select org_id, status::text as status, indexing_paused from app.sites where id = ${siteId}`;
  if (!site) return { site: null, controls: [] };
  const controls = await sql<ControlRow[]>`
    select scope::text as scope, publishing_paused, indexing_paused, reason
    from ops.autonomy_controls
    where (publishing_paused or indexing_paused)
      and (scope = 'global' or (scope = 'org' and org_id = ${site.org_id}) or (scope = 'site' and site_id = ${siteId}))`;
  return { site: { status: site.status, indexing_paused: site.indexing_paused }, controls };
}

/** May this site publish right now? Checked inside the publish step itself, so the answer and the write are one step. */
export async function publishGuard(siteId: string, sql: postgres.Sql = appDb()): Promise<PublishVerdict> {
  return guardVerdict(await loadGuardState(siteId, sql));
}

export interface Held {
  held: string;
}

export function isHeld(r: unknown): r is Held {
  return typeof r === "object" && r !== null && !Array.isArray(r) && typeof (r as Held).held === "string";
}

/**
 * Run a publish step until it is not held: `attempt(n)` is the caller's own
 * `step.run`, which checks publishGuard first and returns `{ held: reason }`
 * instead of publishing. Between attempts the run sleeps PUBLISH_HOLD; after
 * PUBLISH_MAX_HOLDS it returns the last hold for the caller to fail on.
 * Attempt 0 keeps the caller's original step id, so a run already past its
 * publish step replays its memoised result and never meets a new step.
 */
export async function holdWhilePaused<R>(step: Pick<GateStep, "sleep">, attempt: (n: number) => Promise<R | Held>): Promise<R | Held> {
  let result = await attempt(0);
  for (let i = 0; isHeld(result) && i < PUBLISH_MAX_HOLDS; i++) {
    await step.sleep(`publish:hold:${i}`, PUBLISH_HOLD);
    result = await attempt(i + 1);
  }
  return result;
}
