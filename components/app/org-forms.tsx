"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/app/actions";
import { inviteMemberAction, updateOrgSettingsAction } from "@/lib/app/org-actions";

function Note({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  if (!state.ok) return <span className="text-destructive text-xs">{state.error}</span>;
  return <span className="text-muted-foreground text-xs">{state.error ?? "Saved"}</span>;
}

export function InviteForm({ orgId, canInviteAdmins }: { orgId: string; canInviteAdmins: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(inviteMemberAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="orgId" value={orgId} />
      <div className="grid gap-1">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" name="email" type="email" required placeholder="teammate@company.com" className="w-64" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="invite-role">Role</Label>
        <select id="invite-role" name="role" defaultValue="editor" className="border-input bg-background h-9 rounded-md border px-3 text-sm">
          {canInviteAdmins ? <option value="admin">admin</option> : null}
          <option value="editor">editor</option>
          <option value="viewer">viewer</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Inviting…" : "Invite"}</Button>
      <Note state={state} />
    </form>
  );
}

export function SettingsForm({ org, isStaff }: { org: { id: string; name: string; retention_days: number; billing_email: string | null; serp_monthly_budget_usd: number }; isStaff: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(updateOrgSettingsAction, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="orgId" value={org.id} />
      <div className="grid gap-1">
        <Label htmlFor="org-name">Organisation name</Label>
        <Input id="org-name" name="name" defaultValue={org.name} required minLength={2} maxLength={120} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="org-billing-email">Billing email</Label>
        <Input id="org-billing-email" name="billingEmail" type="email" defaultValue={org.billing_email ?? ""} placeholder="finance@company.com" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="org-retention">Context retention (days, 30–3650)</Label>
        <Input id="org-retention" name="retentionDays" type="number" min={30} max={3650} defaultValue={org.retention_days} />
        <p className="text-muted-foreground text-xs">Slack, call and document ingests older than this are purged nightly. Verified facts and published content are kept.</p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="org-budget">SERP budget per month (USD{isStaff ? "" : ", up to 500"})</Label>
        <Input id="org-budget" name="serpBudget" type="number" min={0} max={isStaff ? 5000 : 500} step={1} defaultValue={org.serp_monthly_budget_usd} />
        <p className="text-muted-foreground text-xs">Autocomplete, PAA and AI Overview snapshots stop for the month when this is reached.</p>
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save settings"}</Button>
        <Note state={state} />
      </div>
    </form>
  );
}
