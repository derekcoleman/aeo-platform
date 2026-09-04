import { purgeExpired } from "@/lib/ops/retention";
import { inngest } from "./client";

/** Nightly at 03:30 UTC. Idempotent; a missed night is caught up by the next. */
export const retentionPurgeNightly = inngest.createFunction(
  { id: "retention-purge-nightly", triggers: [{ cron: "30 3 * * *" }], retries: 1 },
  async ({ step }) => {
    const summary = await step.run("purge", () => purgeExpired());
    return summary;
  },
);

export const retentionFunctions = [retentionPurgeNightly];
