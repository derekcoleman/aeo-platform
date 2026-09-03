"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addStaffBootstrapAction } from "@/lib/app/actions";

export function StaffForm() {
  const [state, action, pending] = useActionState(addStaffBootstrapAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="grid gap-2">
        <Label htmlFor="staff-email">Add staff by email</Label>
        <Input id="staff-email" name="email" type="email" placeholder="person@aeo.app" className="w-72" required />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>{pending ? "Adding…" : "Add"}</Button>
      {state ? <Alert variant={state.ok ? "success" : "destructive"} className="w-full"><AlertDescription>{state.ok ? "Added. They become staff on their next sign-in." : state.error}</AlertDescription></Alert> : null}
    </form>
  );
}
