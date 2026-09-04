"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/app/actions";
import { decideApprovalAction } from "@/lib/app/actions";

/**
 * The three decisions on a gate, with an optional note that the pipeline
 * feeds back into the next brief or draft. "Regenerate" re-rolls the stage
 * with the note; "Request changes" keeps the gate open for the author.
 */
export function DecisionForm({ approvalId, kind, sections }: { approvalId: string; kind: "brief" | "draft"; sections: string[] }) {
  const [note, setNote] = useState("");
  const [section, setSection] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const decide = (decision: "approve" | "changes" | "regenerate") =>
    start(async () => {
      const prefix = section ? `Section “${section}”: ` : "";
      const r = await decideApprovalAction(approvalId, decision, `${prefix}${note}`.trim() || undefined);
      setResult(r);
    });
  return (
    <div className="grid gap-3">
      {sections.length ? (
        <div className="grid gap-1">
          <Label htmlFor="decision-section">Section (optional; scopes your note to one heading)</Label>
          <select id="decision-section" className="border-input bg-background h-9 rounded-md border px-3 text-sm" value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">Whole {kind}</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor="decision-note">Note for the writer</Label>
        <Textarea id="decision-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === "brief" ? "e.g. Lead with the SCIM angle; the pricing comparison is out of scope." : "e.g. The second section overstates the SLA; cite the 99.9% fact only."} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending || result?.ok} onClick={() => decide("approve")}>{kind === "brief" ? "Approve brief" : "Approve and publish"}</Button>
        <Button variant="outline" disabled={pending || result?.ok} onClick={() => decide("regenerate")}>Regenerate with note</Button>
        <Button variant="ghost" disabled={pending || result?.ok} onClick={() => decide("changes")}>Request changes</Button>
        {pending ? <span className="text-muted-foreground text-xs">Working…</span> : null}
        {result ? <span className={`text-xs ${result.ok ? "text-muted-foreground" : "text-destructive"}`}>{result.ok ? "Recorded. The pipeline resumes from this gate." : result.error}</span> : null}
      </div>
    </div>
  );
}
