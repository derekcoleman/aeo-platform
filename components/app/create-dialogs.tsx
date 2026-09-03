"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createOrgAction, createSiteAction, type ActionResult } from "@/lib/app/actions";

export function CreateOrgDialog({ first = false }: { first?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: ActionResult | null, form: FormData) => {
    const r = await createOrgAction(prev, form);
    if (r.ok) setOpen(false);
    return r;
  }, null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={first ? "default" : "outline"}><Plus /> New organisation</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New organisation</DialogTitle>
          <DialogDescription>An organisation owns projects, connectors and the brand brain. You become its owner.</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="org-name">Name</Label>
            <Input id="org-name" name="name" placeholder="Acme Inc" required minLength={2} />
          </div>
          {state && !state.ok ? <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert> : null}
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const MODES: { value: string; label: string; note: string }[] = [
  { value: "cloudflare_worker", label: "Cloudflare Worker (recommended)", note: "Strips cookies, verifies the site id, falls back to a mirror, full crawler telemetry." },
  { value: "vercel_rewrite", label: "Vercel rewrite", note: "Cannot strip cookies or add headers at their edge. Disclosed in the install guide." },
  { value: "nginx", label: "nginx / Fastly / Akamai", note: "Full header control; no passthrough or mirror fallback." },
  { value: "netlify", label: "Netlify", note: "Same limits as Vercel." },
  { value: "subdomain", label: "Subdomain (last resort)", note: "Weaker for AI search than a subfolder." },
];

export function CreateSiteDialog({ orgs, defaultOrgId }: { orgs: { id: string; name: string }[]; defaultOrgId?: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("cloudflare_worker");
  const [state, action, pending] = useActionState(createSiteAction, null);
  const note = MODES.find((m) => m.value === mode)?.note;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={orgs.length === 0}><Plus /> New project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A project is one domain plus the path we publish under, served through your edge.</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="site-org">Organisation</Label>
            <Select name="orgId" defaultValue={defaultOrgId ?? orgs[0]?.id}>
              <SelectTrigger id="site-org"><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site-name">Project name</Label>
            <Input id="site-name" name="name" placeholder="Acme resources" required minLength={2} />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="grid gap-2">
              <Label htmlFor="site-domain">Domain</Label>
              <Input id="site-domain" name="domain" placeholder="acme.com" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="site-prefix">Path prefix</Label>
              <Input id="site-prefix" name="pathPrefix" defaultValue="/resources" className="w-36 font-mono" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site-mode">Install mode</Label>
            <Select name="proxyMode" value={mode} onValueChange={setMode}>
              <SelectTrigger id="site-mode"><SelectValue /></SelectTrigger>
              <SelectContent>{MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
            {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site-orgname">Company name for bylines and schema (optional)</Label>
            <Input id="site-orgname" name="organizationName" placeholder="Acme" />
          </div>
          {state && !state.ok ? <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert> : null}
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create project"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
