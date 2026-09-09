"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteSiteAction } from "@/lib/app/actions";

/** Typed-confirmation delete. The action redirects to /app on success, so a resolved call without redirect is an error. */
export function DeleteSiteDialog({ siteId, domain, name, published }: { siteId: string; domain: string; name: string; published: number }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ready = typed.trim().toLowerCase() === domain.toLowerCase();

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setTyped(""); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"><Trash2 /> Delete</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This removes the project and everything in it: {published > 0 ? `${published} published page${published === 1 ? "" : "s"} (they stop being served on ${domain} immediately), ` : ""}drafts, topics, prompts, opportunities, connectors and crawler telemetry. The organisation, its members and the brand brain&apos;s facts are kept. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="delete-confirm">Type <span className="font-mono">{domain}</span> to confirm</Label>
          <Input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={domain} autoComplete="off" />
        </div>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!ready || pending}
            onClick={() =>
              start(async () => {
                const r = await deleteSiteAction(siteId, typed);
                if (r && !r.ok) setError(r.error ?? "Could not delete the project.");
              })
            }
          >
            {pending ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
