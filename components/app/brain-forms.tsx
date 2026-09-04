"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/app/actions";
import { saveManifestAction, upsertEntityAction } from "@/lib/app/brain-actions";

const ENTITY_TYPES = ["brand", "product", "feature", "competitor", "integration", "customer", "person", "category", "other"] as const;

export function EntityForm({ siteId }: { siteId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(upsertEntityAction, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-1">
        <Label htmlFor="entity-name">Name</Label>
        <Input id="entity-name" name="name" required maxLength={120} placeholder="Okta" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="entity-type">Type</Label>
        <select id="entity-type" name="type" className="border-input bg-background h-9 rounded-md border px-3 text-sm" defaultValue="competitor">
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor="entity-aliases">Aliases (comma-separated; matched as whole words, never substrings)</Label>
        <Input id="entity-aliases" name="aliases" placeholder="Okta Workforce Identity, Okta WIC" />
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor="entity-description">Description</Label>
        <Input id="entity-description" name="description" maxLength={600} placeholder="One line on what it is and how we relate to it" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="entity-wikidata">Wikidata id</Label>
        <Input id="entity-wikidata" name="wikidataId" placeholder="Q123456" />
      </div>
      <div className="flex items-end gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Add or update entity"}</Button>
        {state ? <span className={`text-xs ${state.ok ? "text-muted-foreground" : "text-destructive"}`}>{state.ok ? "Saved" : state.error}</span> : null}
      </div>
    </form>
  );
}

export function ManifestForm({ siteId, initial }: { siteId: string; initial: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveManifestAction, null);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-1">
        <Label htmlFor="manifest-doc">Manifest JSON (saved as a new draft; activate it below once you are happy)</Label>
        <Textarea id="manifest-doc" name="doc" defaultValue={initial} rows={22} className="font-mono text-xs" />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save as new draft"}</Button>
        {state ? <span className={`text-xs ${state.ok ? "text-muted-foreground" : "text-destructive"}`}>{state.ok ? "Draft saved" : state.error}</span> : null}
      </div>
    </form>
  );
}
