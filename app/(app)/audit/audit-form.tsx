"use client";

import { useEffect, useRef, useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";

type Phase = { kind: "idle" } | { kind: "submitting" } | { kind: "polling"; id: string; slug: string } | { kind: "error"; message: string };

const ERRORS: Record<string, string> = {
  invalid_url: "That does not look like a public website address.",
  blocked: "We can only scan public websites.",
  rate_limited: "You have scanned a lot of sites in the last hour — try again later.",
  invalid_request: "Please enter a website address.",
};

/**
 * Enqueue via POST /api/audit, then poll /api/audit/[id] until the run
 * completes and hand off to the shareable report page.
 */
export function AuditForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [status, setStatus] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (phase.kind !== "polling") return;
    const { id, slug } = phase;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/audit/${id}`, { cache: "no-store" });
        const data = (await res.json()) as { status: string; error?: string | null; pagesAnalyzed?: number };
        if (cancelled) return;
        if (data.status === "completed") {
          router.push(`/audit/${slug}` as Route);
          return;
        }
        if (data.status === "failed") {
          setPhase({ kind: "error", message: data.error ?? "The audit failed. Please try again." });
          return;
        }
        setStatus(data.status === "running" ? "Crawling and scoring pages…" : "Queued…");
      } catch {
        // transient; keep polling
      }
      timer.current = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase, router]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPhase({ kind: "submitting" });
    const res = await fetch("/api/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: String(form.get("url") ?? ""),
        email: String(form.get("email") ?? "") || null,
        website: String(form.get("website") ?? ""),
      }),
    });
    const data = (await res.json()) as { id?: string | null; slug?: string | null; error?: string; reused?: boolean };
    if (!res.ok || !data.id || !data.slug) {
      setPhase({ kind: "error", message: ERRORS[data.error ?? ""] ?? "Something went wrong. Please try again." });
      return;
    }
    if (data.reused) {
      router.push(`/audit/${data.slug}` as Route);
      return;
    }
    setPhase({ kind: "polling", id: data.id, slug: data.slug });
  }

  const busy = phase.kind === "submitting" || phase.kind === "polling";

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem", marginTop: "1.5rem" }}>
      <label>
        Website
        <input name="url" type="text" required placeholder="acme.com" autoComplete="url" disabled={busy}
          style={{ display: "block", width: "100%", padding: "0.6rem", fontSize: "1rem" }} />
      </label>
      <label>
        Email <span style={{ color: "#888" }}>(optional — we’ll send the report link)</span>
        <input name="email" type="email" placeholder="you@company.com" autoComplete="email" disabled={busy}
          style={{ display: "block", width: "100%", padding: "0.6rem", fontSize: "1rem" }} />
      </label>
      {/* Honeypot: hidden from people, filled in by bots. */}
      <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true"
        style={{ position: "absolute", left: "-10000px", width: 1, height: 1, opacity: 0 }} />
      <button type="submit" disabled={busy} style={{ padding: "0.7rem 1.2rem", fontSize: "1rem" }}>
        {busy ? "Scanning…" : "Run free audit"}
      </button>
      {phase.kind === "polling" && <p role="status">{status || "Queued…"} This usually takes one to three minutes.</p>}
      {phase.kind === "error" && <p role="alert" style={{ color: "#b00020" }}>{phase.message}</p>}
    </form>
  );
}
