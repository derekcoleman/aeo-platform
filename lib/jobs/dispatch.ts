import { after } from "next/server";
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
