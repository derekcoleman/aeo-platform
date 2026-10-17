"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/app/actions";
import { setBudgetCapAction } from "@/lib/app/actions";

/** Staff: one budget's cap, edited in place on Ops → Spend. */
export function BudgetCapForm({ budgetId, capUsd, maxUsd }: { budgetId: string; capUsd: number; maxUsd: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(setBudgetCapAction, null);
  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="budgetId" value={budgetId} />
      <span className="text-muted-foreground text-xs">$</span>
      <Input name="capUsd" type="number" min={0} max={maxUsd} step={1} defaultValue={capUsd} aria-label="Cap in USD" className="h-8 w-24 font-mono" />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      {state ? <span className={state.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs"}>{state.ok ? "Saved" : state.error}</span> : null}
    </form>
  );
}
