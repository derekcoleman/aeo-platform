/**
 * Is a job runner reachable? Inngest is the orchestrator for everything
 * long-running, but a deployment that has not been connected to Inngest yet
 * must not silently enqueue into nothing: the public audit falls back to
 * running in-process (see app/(app)/api/audit/route.ts), and the setup page
 * lists the missing key.
 *
 * Production needs INNGEST_EVENT_KEY (the dashboard's Vercel integration sets
 * it together with INNGEST_SIGNING_KEY). In development the SDK talks to the
 * local dev server without keys, so only an explicit opt-out disables it.
 */
export function inngestConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (env.AEO_JOBS_INLINE === "1" || env.AEO_JOBS_INLINE === "true") return false;
  if (env.INNGEST_EVENT_KEY?.trim()) return true;
  return env.NODE_ENV !== "production" && !env.VERCEL;
}
