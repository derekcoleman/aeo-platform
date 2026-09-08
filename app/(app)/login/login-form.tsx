"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { withTimeout } from "@/lib/async";
import { supabaseBrowser, type BrowserSupabaseConfig } from "@/lib/auth/supabase-browser";

type Phase = { kind: "idle" } | { kind: "sending"; via: "email" | "google" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

const REQUEST_TIMEOUT_MS = 20_000;

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/timed out/i.test(msg)) return "Supabase did not answer within 20 seconds. Check your connection and try again.";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "The browser could not reach Supabase Auth. Check the Supabase URL on this deployment and your connection.";
  return msg || "Something went wrong. Please try again.";
}

/**
 * Magic link by default; Google when the Supabase project has the provider
 * enabled. The Supabase config comes from the server so it does not depend
 * on build-time inlining, and every failure (missing config, network,
 * timeout, Supabase error) ends in a visible message, never a stuck button.
 */
export function LoginForm({ next, initialError, supabase }: { next: string; initialError: string | null; supabase: BrowserSupabaseConfig | null }) {
  const [phase, setPhase] = useState<Phase>(initialError ? { kind: "error", message: initialError } : { kind: "idle" });
  const callback = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  async function sendLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    if (!email) return;
    setPhase({ kind: "sending", via: "email" });
    try {
      const client = supabaseBrowser(supabase);
      const { error } = await withTimeout(client.auth.signInWithOtp({ email, options: { emailRedirectTo: callback() } }), REQUEST_TIMEOUT_MS);
      setPhase(error ? { kind: "error", message: error.message } : { kind: "sent", email });
    } catch (err) {
      setPhase({ kind: "error", message: describe(err) });
    }
  }

  async function google() {
    setPhase({ kind: "sending", via: "google" });
    try {
      const client = supabaseBrowser(supabase);
      const { error } = await withTimeout(client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback() } }), REQUEST_TIMEOUT_MS);
      if (error) setPhase({ kind: "error", message: error.message });
      // On success the browser is navigating to Google; leave the button disabled.
    } catch (err) {
      setPhase({ kind: "error", message: describe(err) });
    }
  }

  if (phase.kind === "sent") {
    return (
      <Alert variant="success">
        <AlertTitle>Check your inbox</AlertTitle>
        <AlertDescription>We sent a sign-in link to {phase.email}. It expires in an hour. If it does not arrive within a couple of minutes, check spam, then try again.</AlertDescription>
      </Alert>
    );
  }
  const sending = phase.kind === "sending";
  return (
    <form onSubmit={sendLink} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required disabled={sending} />
      </div>
      <Button type="submit" disabled={sending}>
        {phase.kind === "sending" && phase.via === "email" ? <Loader2 className="animate-spin" /> : null}
        {phase.kind === "sending" && phase.via === "email" ? "Sending" : "Email me a link"}
      </Button>
      <Button type="button" variant="outline" onClick={google} disabled={sending}>
        {phase.kind === "sending" && phase.via === "google" ? <Loader2 className="animate-spin" /> : null}
        Continue with Google
      </Button>
      {phase.kind === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>Could not sign you in</AlertTitle>
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
