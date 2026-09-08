"use client";

import { useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "polling"; id: string; slug: string; startedAt: number }
  | { kind: "error"; title: string; message: string };

const ERRORS: Record<string, { title: string; message: string }> = {
  invalid_url: { title: "That address does not look right", message: "Enter a public website address such as acme.com." },
  blocked: { title: "We can only scan public websites", message: "Private hosts and internal addresses are skipped." },
  unreachable: { title: "We could not reach that site", message: "The site did not answer. Check the address and try again." },
  not_html: { title: "That address did not return a web page", message: "Point us at the homepage rather than a file or an API." },
  rate_limited: { title: "Slow down a little", message: "You have scanned a lot of sites in the last hour. Try again later." },
  invalid_request: { title: "Please enter a website address", message: "The website field is required." },
  not_configured: { title: "Audits are not set up on this deployment yet", message: "The app has no database connection. The operator needs to set DATABASE_URL and redeploy." },
  server_error: { title: "Something went wrong on our side", message: "The scan could not be started. Please try again in a minute." },
  timeout: { title: "This is taking longer than expected", message: "The scan did not finish within eight minutes. Please try again; if it keeps happening, the site may be very slow to respond." },
};

/** How long the client waits for a result before giving up on a run. */
const CLIENT_DEADLINE_MS = 8 * 60_000;
const POLL_MS = 2500;

/** Parse a response as JSON without ever throwing: an HTML error page maps to `server_error`. */
async function readJson<T extends object>(res: Response): Promise<T & { error?: string }> {
  try {
    return (await res.json()) as T & { error?: string };
  } catch {
    return { error: res.status === 429 ? "rate_limited" : "server_error" } as T & { error?: string };
  }
}

function fail(code: string | undefined): Phase {
  const e = ERRORS[code ?? ""] ?? ERRORS.server_error!;
  return { kind: "error", ...e };
}

/**
 * Enqueue via POST /api/audit, then poll /api/audit/[id] until the run
 * completes and hand off to the shareable report page. Every failure mode
 * (bad address, no database, HTML 500, lost job, network drop) ends in a
 * visible error; the form never stays on "Scanning…" without a way out.
 */
export function AuditForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [status, setStatus] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (phase.kind !== "polling") return;
    const { id, slug, startedAt } = phase;
    let cancelled = false;
    const clock = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > CLIENT_DEADLINE_MS) {
        setPhase(fail("timeout"));
        return;
      }
      try {
        const res = await fetch(`/api/audit/${id}`, { cache: "no-store" });
        const data = await readJson<{ status?: string; error?: string | null; pagesAnalyzed?: number }>(res);
        if (cancelled) return;
        if (!res.ok && data.error && data.error !== "not_found") {
          setPhase(fail(data.error));
          return;
        }
        if (data.status === "completed") {
          router.push(`/audit/${slug}` as Route);
          return;
        }
        if (data.status === "failed") {
          setPhase({ kind: "error", title: "The audit could not finish", message: data.error ?? "Please try again." });
          return;
        }
        setStatus(data.status === "running" ? "Crawling and scoring pages" : "Waiting for a worker");
      } catch {
        // Transient network error; keep polling until the deadline.
      }
      timer.current = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      clearInterval(clock);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase, router]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPhase({ kind: "submitting" });
    setStatus("");
    setElapsed(0);
    let res: Response;
    try {
      res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: String(form.get("url") ?? ""),
          email: String(form.get("email") ?? "") || null,
          website: String(form.get("website") ?? ""),
        }),
      });
    } catch {
      setPhase({ kind: "error", title: "No connection", message: "We could not reach the server. Check your connection and try again." });
      return;
    }
    const data = await readJson<{ id?: string | null; slug?: string | null; reused?: boolean }>(res);
    if (!res.ok || !data.id || !data.slug) {
      setPhase(fail(data.error));
      return;
    }
    if (data.reused) {
      router.push(`/audit/${data.slug}` as Route);
      return;
    }
    setPhase({ kind: "polling", id: data.id, slug: data.slug, startedAt: Date.now() });
  }

  const busy = phase.kind === "submitting" || phase.kind === "polling";

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="audit-url">Website</Label>
        <Input id="audit-url" name="url" type="text" required placeholder="acme.com" autoComplete="url" disabled={busy} className="h-11 text-base" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="audit-email">
          Email <span className="text-muted-foreground font-normal">(optional, we send you the report link)</span>
        </Label>
        <Input id="audit-email" name="email" type="email" placeholder="you@company.com" autoComplete="email" disabled={busy} className="h-11 text-base" />
      </div>
      {/* Honeypot: hidden from people, filled in by bots. */}
      <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[10000px] h-px w-px opacity-0" />
      <Button type="submit" size="lg" disabled={busy} className="h-11">
        {busy ? <Loader2 className="animate-spin" /> : null}
        {phase.kind === "submitting" ? "Starting" : phase.kind === "polling" ? "Scanning" : "Run the free audit"}
        {busy ? null : <ArrowRight />}
      </Button>
      {phase.kind === "polling" ? (
        <div role="status" className="bg-muted/60 rounded-lg px-4 py-3 text-sm">
          <p className="font-medium">{status || "Starting the scan"}…</p>
          <p className="text-muted-foreground mt-1">
            Up to a dozen pages are fetched and scored. This usually takes one to three minutes.{elapsed > 0 ? ` ${elapsed}s elapsed.` : ""}
          </p>
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>{phase.title}</AlertTitle>
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
