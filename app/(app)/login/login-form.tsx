"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabaseBrowser } from "@/lib/auth/supabase-browser";

type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

/** Magic link by default; Google when the Supabase project has the provider enabled. */
export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const [phase, setPhase] = useState<Phase>(initialError ? { kind: "error", message: initialError } : { kind: "idle" });
  const callback = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  async function sendLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    if (!email) return;
    setPhase({ kind: "sending" });
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email, options: { emailRedirectTo: callback() } });
    setPhase(error ? { kind: "error", message: error.message } : { kind: "sent", email });
  }

  async function google() {
    setPhase({ kind: "sending" });
    const { error } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback() } });
    if (error) setPhase({ kind: "error", message: error.message });
  }

  if (phase.kind === "sent") {
    return (
      <Alert variant="success">
        <AlertDescription>Check {phase.email} for your sign-in link. It expires in an hour.</AlertDescription>
      </Alert>
    );
  }
  return (
    <form onSubmit={sendLink} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required disabled={phase.kind === "sending"} />
      </div>
      <Button type="submit" disabled={phase.kind === "sending"}>{phase.kind === "sending" ? "Sending…" : "Email me a link"}</Button>
      <Button type="button" variant="outline" onClick={google} disabled={phase.kind === "sending"}>Continue with Google</Button>
      {phase.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
