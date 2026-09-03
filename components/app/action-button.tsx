"use client";

import { useState, useTransition } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { ActionResult } from "@/lib/app/actions";

/** A button that runs a server action, shows progress, and surfaces the result inline. */
export function ActionButton({ action, children, done = "Done", ...props }: { action: () => Promise<ActionResult>; done?: string } & Omit<ButtonProps, "onClick">) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        {...props}
        disabled={pending || props.disabled}
        onClick={() => {
          setNote(null);
          start(async () => {
            const r = await action();
            setNote(r.ok ? done : r.error ?? "Failed");
            if (r.ok) setTimeout(() => setNote(null), 4000);
          });
        }}
      >
        {pending ? "Working…" : children}
      </Button>
      {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
    </span>
  );
}
