"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/app/actions";
import { connectWebflowAction, createTargetAction, updateTargetAction } from "@/lib/app/publishing-actions";
import type { FieldMap } from "@/lib/connectors/webflow";

const selectClass = "border-input bg-background h-9 rounded-md border px-3 text-sm";

function Note({ state, okText = "Saved" }: { state: ActionResult | null; okText?: string }) {
  if (!state) return null;
  if (!state.ok) return <span className="text-destructive text-xs">{state.error}</span>;
  return <span className="text-muted-foreground text-xs">{state.error ?? okText}</span>;
}

export function WebflowConnectForm({ siteId }: { siteId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(connectWebflowAction, null);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-1">
        <Label htmlFor="wf-token">Webflow site API token</Label>
        <Input id="wf-token" name="token" type="password" required autoComplete="off" placeholder="Site settings → Apps & integrations → API access → Generate (cms:read, cms:write)" />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Checking…" : "Connect Webflow"}</Button>
        <Note state={state} okText="Connected. Now choose the collection to publish into." />
      </div>
    </form>
  );
}

export interface SiteOption {
  id: string;
  name: string;
  collections: { id: string; name: string; slug: string }[];
}

export function TargetPicker({ siteId, connectionId, sites }: { siteId: string; connectionId: string; sites: SiteOption[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createTargetAction, null);
  const [wfSite, setWfSite] = useState(sites[0]?.id ?? "");
  const collections = sites.find((s) => s.id === wfSite)?.collections ?? [];
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <div className="grid gap-1">
        <Label>Webflow site</Label>
        <select name="webflowSiteId" className={selectClass} value={wfSite} onChange={(e) => setWfSite(e.target.value)}>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div className="grid gap-1">
        <Label>Collection (your blog posts)</Label>
        <select name="collectionId" className={selectClass} defaultValue={collections[0]?.id ?? ""}>
          {collections.map((c) => <option key={c.id} value={c.id}>{c.name} (/{c.slug})</option>)}
        </select>
      </div>
      <Button type="submit" disabled={pending || collections.length === 0}>{pending ? "Reading fields…" : "Add publish target"}</Button>
      <Note state={state} okText="Target added; review the field map below." />
    </form>
  );
}

export function FieldMapForm({ targetId, fields, fieldMap, publishLive, autoPush, enabled, canonicalMode }: { targetId: string; fields: { slug: string; displayName: string; type: string }[]; fieldMap: FieldMap; publishLive: boolean; autoPush: boolean; enabled: boolean; canonicalMode: "proxy" | "webflow" | "none" }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(updateTargetAction, null);
  const opts = (types: string[], allowNone: boolean) => (
    <>
      {allowNone ? <option value="">— not mapped —</option> : null}
      {fields.filter((f) => types.length === 0 || types.includes(f.type)).map((f) => <option key={f.slug} value={f.slug}>{f.displayName} · {f.slug} ({f.type})</option>)}
    </>
  );
  const slot = (label: string, name: keyof FieldMap, types: string[], allowNone: boolean) => (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <select name={name} className={selectClass} defaultValue={fieldMap[name] ?? ""}>{opts(types, allowNone)}</select>
    </div>
  );
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="targetId" value={targetId} />
      {slot("Title →", "name", [], false)}
      {slot("Slug →", "slug", [], false)}
      {slot("Article body (rich text) →", "body", ["RichText"], false)}
      {slot("Summary / excerpt →", "summary", ["PlainText", "Text", "RichText"], true)}
      {slot("Main image →", "image", ["Image"], true)}
      {slot("Published date →", "publishedAt", ["DateTime"], true)}
      {slot("Canonical URL →", "canonical", ["PlainText", "Link", "Text"], true)}
      {slot("Author name →", "author", ["PlainText", "Text"], true)}
      <div className="grid gap-1">
        <Label>Canonical</Label>
        <select name="canonicalMode" className={selectClass} defaultValue={canonicalMode}>
          <option value="proxy">Proxy copy is canonical (write it into the canonical field)</option>
          <option value="webflow">Webflow copy is canonical</option>
          <option value="none">Do not set</option>
        </select>
      </div>
      <div className="grid gap-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="publishLive" value="1" defaultChecked={publishLive} /> Publish live (otherwise staged as a draft in Webflow)</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="autoPush" value="1" defaultChecked={autoPush} /> Push every newly published article automatically</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="enabled" value="1" defaultChecked={enabled} /> Target enabled</label>
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save field map"}</Button>
        <Note state={state} />
      </div>
    </form>
  );
}
