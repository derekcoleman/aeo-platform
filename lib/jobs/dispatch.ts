import { after } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { inngestConfigured } from "./runner";

/**
 * Hand a job to Inngest when it is connected; otherwise run it in this
 * process after the response is sent. The inline path exists so a fresh
 * deployment can be used before the job runner is wired, and so a failed
 * event send never strands a row in "queued". Callers pass both closures;
 * the return value says which one ran.
 */
export async function dispatch(send: () => Promise<unknown>, inline: () => Promise<unknown>, label = "job"): Promise<"inngest" | "inline"> {
  if (inngestConfigured()) {
    try {
      await send();
      return "inngest";
    } catch (e) {
      console.error(`[jobs] inngest send failed for ${label}, running inline: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  after(async () => {
    try {
      await inline();
    } catch (e) {
      console.error(`[jobs] inline ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return "inline";
}

export const JOBS_NOT_CONFIGURED = "Inngest is not connected on this deployment, so background jobs cannot run. Install the Inngest Vercel integration (it sets INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY) and redeploy.";

/**
 * Queue one or more events for Inngest from a server action. Returns null on
 * success, otherwise a message the action can return inline. Never throws:
 * an unconfigured runner or a refused send is an ordinary outcome the button
 * should show, not a crash page.
 */
export async function queueJob(events: unknown, send: (e: never) => Promise<unknown> = (e) => inngest.send(e), label = "job"): Promise<string | null> {
  if (!inngestConfigured()) return JOBS_NOT_CONFIGURED;
  try {
    await send(events as never);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[jobs] queue failed for ${label}: ${message}`);
    return `Could not queue the ${label}: ${message.split("\n")[0]?.slice(0, 200)}`;
  }
}
