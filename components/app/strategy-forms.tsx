"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/app/actions";
import { addPromptAction, connectProfoundAction, createContentAction, saveTopicAction } from "@/lib/app/strategy-actions";
import type { TopicRow } from "@/lib/strategy/topics";

const FORMATS = ["comparison", "howto", "guide", "listicle", "faq"] as const;

function Note({ state, okText = "Saved" }: { state: ActionResult | null; okText?: string }) {
  if (!state) return null;
  if (!state.ok) return <span className="text-destructive text-xs">{state.error}</span>;
  return <span className="text-muted-foreground text-xs">{state.error ?? okText}</span>;
}

const selectClass = "border-input bg-background h-9 rounded-md border px-3 text-sm";

export function TopicForm({ siteId, topic, onDone }: { siteId: string; topic?: TopicRow | null; onDone?: () => void }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(async (prev, form) => {
    const r = await saveTopicAction(prev, form);
    if (r.ok) onDone?.();
    return r;
  }, null);
  const [formats, setFormats] = useState<string[]>(topic?.formats ?? []);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="siteId" value={siteId} />
      {topic ? <input type="hidden" name="topicId" value={topic.id} /> : null}
      <input type="hidden" name="formats" value={formats.join(",")} />
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor={`topic-name-${topic?.id ?? "new"}`}>Topic</Label>
        <Input id={`topic-name-${topic?.id ?? "new"}`} name="name" required minLength={2} maxLength={120} defaultValue={topic?.name ?? ""} placeholder="SCIM provisioning" />
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label>Description (what we want to be known for here)</Label>
        <Input name="description" maxLength={600} defaultValue={topic?.description ?? ""} placeholder="Identity lifecycle automation for mid-market IT" />
      </div>
      <div className="grid gap-1">
        <Label>Priority (1–5)</Label>
        <Input name="priority" type="number" min={1} max={5} defaultValue={topic?.priority ?? 3} />
      </div>
      <div className="grid gap-1">
        <Label>Pieces per month</Label>
        <Input name="cadencePerMonth" type="number" min={0} max={30} defaultValue={topic?.cadence_per_month ?? 2} />
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label>Preferred formats (first is the default)</Label>
        <div className="flex flex-wrap gap-2">
          {FORMATS.map((f) => {
            const on = formats.includes(f);
            return <Button key={f} type="button" size="sm" variant={on ? "default" : "outline"} onClick={() => setFormats(on ? formats.filter((x) => x !== f) : [...formats, f])}>{f}</Button>;
          })}
        </div>
      </div>
      <div className="grid gap-1">
        <Label>Seed terms (attach questions; one per line)</Label>
        <Textarea name="seedTerms" rows={4} defaultValue={topic?.seed_terms.join("\n") ?? ""} placeholder={"scim\nuser provisioning\nscim vs sso"} />
      </div>
      <div className="grid gap-1">
        <Label>Competitor domains to watch (one per line)</Label>
        <Textarea name="competitorDomains" rows={4} defaultValue={topic?.competitor_domains.join("\n") ?? ""} placeholder={"okta.com\nonelogin.com"} />
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label>Notes for the writer (POV, must-mention, must-avoid)</Label>
        <Textarea name="notes" rows={2} defaultValue={topic?.notes ?? ""} />
      </div>
      <div className="grid gap-1">
        <Label>Status</Label>
        <select name="status" defaultValue={topic?.status ?? "active"} className={selectClass}>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="archived">archived</option>
        </select>
      </div>
      <div className="flex items-end gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : topic ? "Save topic" : "Create topic"}</Button>
        <Note state={state} />
      </div>
    </form>
  );
}

export function EditTopic({ siteId, topic }: { siteId: string; topic: TopicRow }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Edit</Button>;
  return (
    <div className="mt-3 rounded-md border p-3">
      <TopicForm siteId={siteId} topic={topic} onDone={() => setOpen(false)} />
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(false)}>Close</Button>
    </div>
  );
}

export function PromptForm({ siteId, topics }: { siteId: string; topics: Pick<TopicRow, "id" | "name">[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(addPromptAction, null);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-1">
        <Label htmlFor="prompt-text">Prompts or questions to track (one per line)</Label>
        <Textarea id="prompt-text" name="text" rows={4} required placeholder={"best scim providers for mid-market\nokta vs entra id for scim"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1">
          <Label>Topic</Label>
          <select name="topicId" className={selectClass} defaultValue="">
            <option value="">(auto by seed terms)</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1">
          <Label>Snapshot cadence</Label>
          <select name="tier" className={selectClass} defaultValue="weekly">
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
            <option value="none">track only</option>
          </select>
        </div>
        <div className="flex items-end gap-3">
          <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add prompts"}</Button>
          <Note state={state} okText="Added" />
        </div>
      </div>
    </form>
  );
}

export function ContentRequestForm({ siteId, topics, defaultTitle, questionId, defaultTopicId, compact }: { siteId: string; topics: Pick<TopicRow, "id" | "name" | "formats">[]; defaultTitle?: string; questionId?: string; defaultTopicId?: string | null; compact?: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createContentAction, null);
  const [open, setOpen] = useState(!compact);
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Write about this</Button>;
  return (
    <form action={action} className="grid gap-2 rounded-md border p-3">
      <input type="hidden" name="siteId" value={siteId} />
      {questionId ? <input type="hidden" name="questionId" value={questionId} /> : null}
      <div className="grid gap-1">
        <Label>Working title or question</Label>
        <Input name="title" required minLength={5} maxLength={300} defaultValue={defaultTitle ?? ""} placeholder="Okta vs Entra ID for SCIM provisioning: which fits a 200-person team?" />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select name="topicId" className={selectClass} defaultValue={defaultTopicId ?? ""}>
          <option value="">No topic</option>
          {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select name="format" className={selectClass} defaultValue="">
          <option value="">Format: topic default</option>
          {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="startNow" value="1" defaultChecked /> Draft now</label>
      </div>
      <Input name="note" maxLength={1000} placeholder="Note for the writer (optional)" />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Queueing…" : "Queue it"}</Button>
        {compact ? <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button> : null}
        <Note state={state} okText="Queued" />
      </div>
    </form>
  );
}

export function ProfoundConnectForm({ siteId }: { siteId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(connectProfoundAction, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor="profound-key">Profound API key (Enterprise plan)</Label>
        <Input id="profound-key" name="apiKey" type="password" required autoComplete="off" />
      </div>
      <div className="grid gap-1">
        <Label>Category id (leave blank to auto-pick when the key sees one category)</Label>
        <Input name="categoryId" placeholder="cat_…" />
      </div>
      <div className="grid gap-1">
        <Label>API base URL (only if Profound gave you a different one)</Label>
        <Input name="baseUrl" placeholder="https://api.tryprofound.com/v1" />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Checking…" : "Connect Profound"}</Button>
        <Note state={state} okText="Connected; the 90-day backfill is queued." />
      </div>
    </form>
  );
}
