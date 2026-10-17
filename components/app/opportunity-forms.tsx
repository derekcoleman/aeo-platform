"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/app/actions";

/** Dismiss a queue entry with a reason: the queue learns what "not this" means, and the reason is kept on the row. */
export function DismissOpportunity({ action, reasons }: { action: (reason: string) => Promise<ActionResult>; reasons: { value: string; label: string }[] }) {
  const [reason, setReason] = useState(reasons[0]?.value ?? "other");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1">
      <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Why dismiss" className="border-input bg-background h-8 rounded-md border px-2 text-xs" disabled={pending}>
        {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setNote(null);
          start(async () => {
            const r = await action(reason);
            setNote(r.ok ? "Dismissed" : r.error ?? "Failed");
          });
        }}
      >
        {pending ? "Working…" : "Dismiss"}
      </Button>
      {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
    </span>
  );
}
