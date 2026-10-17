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
 *
 * The pipeline's own publish step also holds at the site's publishing pace
 * (publishVelocity): a site that has already published its week's pages
 * waits, until the oldest of them leaves the 7-day window, rather than
 * going live in a burst Google reads as scaled content.
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

export type PublishVerdict = { ok: true } | { ok: false; reason: string; until?: Date };

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

// ── publishing pace ─────────────────────────────────────────────────────────

export const VELOCITY_WINDOW_DAYS = 7;
export const VELOCITY_TRAILING_DAYS = 90;
export const VELOCITY_MIN = 2;
export const VELOCITY_MAX_DEFAULT = 5;

/**
 * Pages a site may publish in any 7 days: one and a half times its trailing
 * weekly cadence (the last 90 days over 13 weeks), at least 2 and at most 5.
 * A new site starts at 2 and earns its way up by publishing. Staff move the
 * ceiling with AEO_PUBLISH_VELOCITY_MAX (a ceiling below 2 lowers the floor
 * with it, to throttle every site).
 */
export function velocityCap(published90d: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AEO_PUBLISH_VELOCITY_MAX?.trim();
  const override = raw ? Number(raw) : NaN;
  const ceiling = Number.isFinite(override) && override >= 1 ? Math.floor(override) : VELOCITY_MAX_DEFAULT;
  const floor = Math.min(VELOCITY_MIN, ceiling);
  return Math.max(floor, Math.min(ceiling, Math.round((1.5 * Math.max(0, published90d)) / 13)));
}

export interface VelocityState {
  cap: number;
  published7d: number;
  published90d: number;
  /** When the oldest publish in the window leaves it; null when the window is empty. */
  nextSlotAt: Date | null;
}

/**
 * The site's pace. A publish is a content item whose latest publish of new
 * work by the pipeline (`pipeline_published_at`) falls in the window: new
 * pages and refreshes both count, CMS refreshes included; a rollback, which
 * puts back what was there, does not. `contentItemId` is the item about to
 * be published: it is left out of the window, since publishing it again
 * adds no page to it, and a publish step retried after its own write is
 * never held by that write.
 */
export async function publishVelocity(
  siteId: string,
  sql: postgres.Sql = appDb(),
  env: NodeJS.ProcessEnv = process.env,
  opts: { contentItemId?: string | null } = {},
): Promise<VelocityState> {
  const inWindow = sql`pipeline_published_at >= now() - make_interval(days => ${VELOCITY_WINDOW_DAYS}) and id is distinct from ${opts.contentItemId ?? null}::uuid`;
  const [row] = await sql<{ published_7d: number; published_90d: number; oldest_7d: Date | null }[]>`
    select count(*) filter (where ${inWindow})::int as published_7d,
           count(*)::int as published_90d,
           min(pipeline_published_at) filter (where ${inWindow}) as oldest_7d
    from content.content_items
    where site_id = ${siteId} and pipeline_published_at >= now() - make_interval(days => ${VELOCITY_TRAILING_DAYS})`;
  const published7d = row?.published_7d ?? 0;
  const published90d = row?.published_90d ?? 0;
  const oldest = row?.oldest_7d ? new Date(row.oldest_7d) : null;
  return { cap: velocityCap(published90d, env), published7d, published90d, nextSlotAt: oldest ? new Date(oldest.getTime() + VELOCITY_WINDOW_DAYS * 86_400_000) : null };
}

/** Pure: hold when the window is full, until its oldest publish leaves it. */
export function velocityVerdict(v: VelocityState): PublishVerdict {
  if (v.published7d < v.cap) return { ok: true };
  return {
    ok: false,
    reason: `this project has published ${v.published7d} page${v.published7d === 1 ? "" : "s"} in the last ${VELOCITY_WINDOW_DAYS} days, its pace allows ${v.cap}`,
    ...(v.nextSlotAt ? { until: v.nextSlotAt } : {}),
  };
}

/**
 * May this site publish right now? Checked inside the publish step itself, so
 * the answer and the write are one step. `velocity` adds the pace check: the
 * pipeline's publish step asks for it, naming the item it publishes, a push
 * of an already-published page to a CMS target does not.
 */
export async function publishGuard(
  siteId: string,
  sql: postgres.Sql = appDb(),
  opts: { velocity?: boolean; contentItemId?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<PublishVerdict> {
  const verdict = guardVerdict(await loadGuardState(siteId, sql));
  if (!verdict.ok || !opts.velocity) return verdict;
  return velocityVerdict(await publishVelocity(siteId, sql, opts.env, { contentItemId: opts.contentItemId }));
}

export interface Held {
  held: string;
  /** Hold until this time (ISO) instead of PUBLISH_HOLD: the publishing pace frees a slot then. */
  until?: string;
}

export function isHeld(r: unknown): r is Held {
  return typeof r === "object" && r !== null && !Array.isArray(r) && typeof (r as Held).held === "string";
}

/** The held result a publish step returns for a verdict that is not ok. */
export function heldFor(verdict: Exclude<PublishVerdict, { ok: true }>): Held {
  return verdict.until ? { held: verdict.reason, until: verdict.until.toISOString() } : { held: verdict.reason };
}

/**
 * Run a publish step until it is not held: `attempt(n)` is the caller's own
 * `step.run`, which checks publishGuard first and returns `{ held: reason }`
 * instead of publishing. Between attempts the run sleeps PUBLISH_HOLD, or
 * until the hold's `until` (the publishing pace); after PUBLISH_MAX_HOLDS
 * it returns the last hold for the caller to fail on. Attempt 0 keeps the
 * caller's original step id, so a run already past its publish step replays
 * its memoised result and never meets a new step.
 */
export async function holdWhilePaused<R>(step: Pick<GateStep, "sleep" | "sleepUntil">, attempt: (n: number) => Promise<R | Held>): Promise<R | Held> {
  let result = await attempt(0);
  for (let i = 0; isHeld(result) && i < PUBLISH_MAX_HOLDS; i++) {
    if (result.until) await step.sleepUntil(`publish:hold:${i}`, new Date(result.until));
    else await step.sleep(`publish:hold:${i}`, PUBLISH_HOLD);
    result = await attempt(i + 1);
  }
  return result;
}
