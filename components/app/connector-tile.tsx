"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

/**
 * One connector as a compact button. The tile shows the name, the state and
 * one line; everything else (what it feeds, the rows that exist, the connect
 * and configure forms) lives in the dialog it opens. The dialog body is
 * rendered by the server page and passed in as children.
 */

export type TileState = "connected" | "needs_setup" | "error" | "not_connected";

const STATE_LABEL: Record<TileState, string> = { connected: "Connected", needs_setup: "Needs setup", error: "Error", not_connected: "Not connected" };
const STATE_VARIANT: Record<TileState, "success" | "warning" | "destructive" | "outline"> = { connected: "success", needs_setup: "warning", error: "destructive", not_connected: "outline" };
const STATE_RING: Record<TileState, string> = { connected: "border-emerald-500/40", needs_setup: "border-amber-500/50", error: "border-destructive/50", not_connected: "" };

export function ConnectorTile({ name, tagline, state, count, scope, children }: { name: string; tagline: string; state: TileState; count: number; scope: "site" | "org"; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`bg-card hover:bg-accent/40 flex min-h-24 flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors ${STATE_RING[state]}`}
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <Badge variant={STATE_VARIANT[state]} className="shrink-0">{STATE_LABEL[state]}{count > 1 ? ` · ${count}` : ""}</Badge>
        </span>
        <span className="text-muted-foreground line-clamp-2 text-xs">{tagline}</span>
        <span className="text-muted-foreground mt-auto text-[11px]">{scope === "site" ? "This project" : "Whole organisation"}</span>
      </button>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{name} <Badge variant={STATE_VARIANT[state]}>{STATE_LABEL[state]}</Badge></DialogTitle>
          <DialogDescription>{tagline}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
