"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/app/actions";
import { mineDemandAction } from "@/lib/app/demand-actions";

export function MineForm({ siteId, suggestedSeeds }: { siteId: string; suggestedSeeds: string[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(mineDemandAction, null);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-1">
        <Label htmlFor="mine-seeds">Seed terms (one per line: category terms, competitor names, ICP pains, product names)</Label>
        <Textarea id="mine-seeds" name="seeds" rows={5} defaultValue={suggestedSeeds.join("\n")} placeholder={"sso vs scim\nokta alternative\nuser provisioning"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="grid gap-1"><Label htmlFor="mine-country">Country</Label><Input id="mine-country" name="country" defaultValue="us" maxLength={2} /></div>
        <div className="grid gap-1"><Label htmlFor="mine-language">Language</Label><Input id="mine-language" name="language" defaultValue="en" maxLength={5} /></div>
        <div className="grid gap-1"><Label htmlFor="mine-depth">Expansion depth (1–3)</Label><Input id="mine-depth" name="depth" type="number" min={1} max={3} defaultValue={2} /></div>
        <div className="grid gap-1"><Label htmlFor="mine-track">Auto-track top N (weekly)</Label><Input id="mine-track" name="trackTop" type="number" min={0} max={500} defaultValue={50} /></div>
      </div>
      <input type="hidden" name="paa" value="true" />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Queueing…" : "Mine questions"}</Button>
        {state ? <span className={`text-xs ${state.ok ? "text-muted-foreground" : "text-destructive"}`}>{state.ok ? "Queued. Autocomplete and People-Also-Ask expansion runs in the background; refresh in a few minutes." : state.error}</span> : null}
      </div>
    </form>
  );
}
