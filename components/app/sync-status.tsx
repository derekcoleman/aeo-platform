import type { Route } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SyncState } from "@/lib/connectors/sync-status";

/**
 * One line (or one alert) that says what a connection's sync is doing:
 * queued, running, failed with the reason, stalled, lost by the job runner,
 * or last succeeded with the numbers. Server component.
 */
export function SyncStatus({ state, setupHref }: { state: SyncState; setupHref?: string | null }) {
  if (state.phase === "idle") return null;
  const trouble = state.phase === "failed" || state.phase === "stalled" || state.phase === "lost";
  if (trouble) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{state.title}</AlertTitle>
        <AlertDescription>
          {state.detail ? <p className="break-words">{state.detail}</p> : null}
          {state.fix ? (
            <p className="mt-1">
              {state.fix}
              {state.phase === "lost" && setupHref ? <> <Link className="underline underline-offset-2" href={setupHref as Route}>Open the setup checks.</Link></> : null}
            </p>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-muted-foreground flex items-start gap-2 text-sm">
      {state.live ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>
        <span className="text-foreground font-medium">{state.title}</span>
        {state.detail ? <> · {state.detail}</> : null}
      </span>
    </p>
  );
}
