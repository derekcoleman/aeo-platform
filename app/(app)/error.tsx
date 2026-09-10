"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the app plane. Anything a page or action throws lands
 * here with a retry and the digest Vercel logs under, instead of the bare
 * "Application error" screen.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          <p>{error.message || "An unexpected error occurred."}</p>
          {error.digest ? <p className="text-muted-foreground font-mono text-xs">digest {error.digest}</p> : null}
        </AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline"><Link href="/app">Back to projects</Link></Button>
      </div>
    </main>
  );
}
