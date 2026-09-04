import { connectorContext } from "@/lib/connectors";
import { loadPublishTarget, pushItemEverywhere, pushItemToTarget } from "@/lib/publishing/targets";
import { contentPublished, inngest, publishingPushRequested } from "./client";

/**
 * External publishing. `content/published` fans out to every enabled
 * auto-push target; `publishing/push.requested` is the manual re-push (one
 * target or all, optionally forced past the payload-hash check). Failures
 * land in content.external_publications, never in the pipeline's own run.
 */
export const publishingOnPublished = inngest.createFunction(
  { id: "publishing-on-published", triggers: [{ event: contentPublished }], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 2 },
  async ({ event, step }) => {
    const { contentItemId, siteId } = event.data;
    const results = await step.run("push-all", () => pushItemEverywhere(contentItemId, siteId, connectorContext(), { onlyAuto: true }));
    return { pushed: results.filter((r) => r.result.ok).length, results: results.map((r) => ({ targetId: r.targetId, ok: r.result.ok, skipped: r.result.skipped ?? null, error: r.result.error ?? null })) };
  },
);

export const publishingPush = inngest.createFunction(
  { id: "publishing-push", triggers: [{ event: publishingPushRequested }], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 1 },
  async ({ event, step }) => {
    const { contentItemId, siteId, targetId, force } = event.data;
    if (targetId) {
      const result = await step.run("push-one", async () => {
        const target = await loadPublishTarget(targetId);
        if (!target || target.site_id !== siteId) return { ok: false, error: "target not found for site" };
        return pushItemToTarget(contentItemId, target, connectorContext(), { force: !!force });
      });
      return { results: [{ targetId, ...result }] };
    }
    const results = await step.run("push-all", () => pushItemEverywhere(contentItemId, siteId, connectorContext(), { force: !!force }));
    return { results: results.map((r) => ({ targetId: r.targetId, ...r.result })) };
  },
);

export const publishingFunctions = [publishingOnPublished, publishingPush];
