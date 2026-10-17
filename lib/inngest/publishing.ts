import { NonRetriableError } from "inngest";
import { connectorContext } from "@/lib/connectors";
import { heldFor, holdWhilePaused, isHeld, publishGuard } from "@/lib/pipeline/guard";
import { loadPublishTarget, pushItemEverywhere, pushItemToTarget } from "@/lib/publishing/targets";
import { contentPublished, inngest, publishingPushRequested } from "./client";

/**
 * External publishing. `content/published` fans out to every enabled
 * auto-push target; `publishing/push.requested` is the manual re-push (one
 * target or all, optionally forced past the payload-hash check). Failures
 * land in content.external_publications, never in the pipeline's own run.
 *
 * Every push passes the same kill switch as the pipeline's publish step
 * (lib/pipeline/guard.ts): while it holds, the run sleeps and asks again,
 * and after three days it fails without pushing.
 */
const paused = (reason: string) => new NonRetriableError(`publishing paused: ${reason}`);

export const publishingOnPublished = inngest.createFunction(
  { id: "publishing-on-published", triggers: [{ event: contentPublished }], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 2 },
  async ({ event, step }) => {
    const { contentItemId, siteId } = event.data;
    const results = await holdWhilePaused(step, (n) => step.run(n === 0 ? "push-all" : `push-all:${n}`, async () => {
      const verdict = await publishGuard(siteId);
      return verdict.ok ? pushItemEverywhere(contentItemId, siteId, connectorContext(), { onlyAuto: true }) : heldFor(verdict);
    }));
    if (isHeld(results)) throw paused(results.held);
    return { pushed: results.filter((r) => r.result.ok).length, results: results.map((r) => ({ targetId: r.targetId, ok: r.result.ok, skipped: r.result.skipped ?? null, error: r.result.error ?? null })) };
  },
);

export const publishingPush = inngest.createFunction(
  { id: "publishing-push", triggers: [{ event: publishingPushRequested }], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 1 },
  async ({ event, step }) => {
    const { contentItemId, siteId, targetId, force } = event.data;
    if (targetId) {
      const result = await holdWhilePaused(step, (n) => step.run(n === 0 ? "push-one" : `push-one:${n}`, async () => {
        const verdict = await publishGuard(siteId);
        if (!verdict.ok) return heldFor(verdict);
        const target = await loadPublishTarget(targetId);
        if (!target || target.site_id !== siteId) return { ok: false, error: "target not found for site" };
        return pushItemToTarget(contentItemId, target, connectorContext(), { force: !!force });
      }));
      if (isHeld(result)) throw paused(result.held);
      return { results: [{ targetId, ...result }] };
    }
    const results = await holdWhilePaused(step, (n) => step.run(n === 0 ? "push-all" : `push-all:${n}`, async () => {
      const verdict = await publishGuard(siteId);
      return verdict.ok ? pushItemEverywhere(contentItemId, siteId, connectorContext(), { force: !!force }) : heldFor(verdict);
    }));
    if (isHeld(results)) throw paused(results.held);
    return { results: results.map((r) => ({ targetId: r.targetId, ...r.result })) };
  },
);

export const publishingFunctions = [publishingOnPublished, publishingPush];
