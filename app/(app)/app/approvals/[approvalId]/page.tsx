import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DecisionForm } from "@/components/app/decision-form";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadApprovalDetail, loadQaResults } from "@/lib/app/content";
import { loadSite } from "@/lib/app/store";
import { canEdit, requireUser, roleIn } from "@/lib/auth/session";
import { loadContentFacts, loadSources } from "@/lib/pipeline/versions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function headingsOf(md: string): string[] {
  return md.split("\n").filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, "").trim()).slice(0, 20);
}

export default async function ApprovalPage({ params }: { params: Promise<{ approvalId: string }> }) {
  const { approvalId } = await params;
  const user = await requireUser(`/app/approvals/${approvalId}`);
  const approval = await loadApprovalDetail(approvalId);
  if (!approval) notFound();
  const site = await loadSite(approval.site_id);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const editor = canEdit(user, site.org_id);
  const version = approval.version;
  const [sources, facts, qa] = version ? await Promise.all([loadSources(version.id), loadContentFacts(version.id), loadQaResults(version.id)]) : [[], [], []];
  const brief = approval.brief;
  const sections = version ? headingsOf(version.body_md) : brief ? brief.spec.outline.map((o) => o.heading) : [];
  const decided = approval.status !== "pending";

  return (
    <AppShell user={user} active="projects">
      <PageHeader title={version?.title ?? brief?.spec.title ?? "Approval"} description={`${site.name} · ${approval.kind === "brief" ? "Brief approval" : "Draft approval"} · requested ${when(approval.requested_at)}`}>
        <Badge variant={approval.status === "pending" ? "warning" : approval.status === "approve" ? "success" : "secondary"}>{approval.status}</Badge>
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${site.id}/content` as Route}>All content</Link></Button>
      </PageHeader>

      {decided ? (
        <Alert className="mb-4">
          <AlertTitle>Already decided</AlertTitle>
          <AlertDescription>{approval.status} {approval.decided_at ? when(approval.decided_at) : ""}{approval.note ? ` — “${approval.note}”` : ""}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid gap-4">
          {brief ? (
            <Card>
              <CardHeader>
                <CardTitle>Brief v{brief.version}</CardTitle>
                <CardDescription>{brief.opportunity_title ? `From opportunity: ${brief.opportunity_title}. ` : ""}Ninety seconds here decides most of the output quality: is this the question, is that the answer, are these the headings a buyer would ask?</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                <div><p className="text-muted-foreground text-xs uppercase">Head question</p><p className="text-lg font-medium">{brief.spec.headQuestion}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase">Target answer (what gets cited)</p><p>{brief.target_answer}</p></div>
                <div className="grid gap-1 sm:grid-cols-2">
                  <div><p className="text-muted-foreground text-xs uppercase">Title</p><p>{brief.spec.title}</p></div>
                  <div><p className="text-muted-foreground text-xs uppercase">Intent</p><Badge variant="outline">{brief.spec.intent}</Badge></div>
                </div>
                <div><p className="text-muted-foreground text-xs uppercase">Description</p><p>{brief.spec.description}</p></div>
                <div>
                  <p className="text-muted-foreground text-xs uppercase">Outline (every H2 a real buyer question)</p>
                  <ol className="mt-1 list-decimal pl-5">
                    {brief.spec.outline.map((o) => <li key={o.heading} className="mb-1"><span className="font-medium">{o.heading}</span>{o.goal ? <span className="text-muted-foreground"> — {o.goal}</span> : null}</li>)}
                  </ol>
                </div>
                {brief.spec.faq.length ? <div><p className="text-muted-foreground text-xs uppercase">FAQ</p><ul className="list-disc pl-5">{brief.spec.faq.map((q) => <li key={q}>{q}</li>)}</ul></div> : null}
                {brief.spec.pov ? <div><p className="text-muted-foreground text-xs uppercase">Point of view</p><p>{brief.spec.pov}</p></div> : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><p className="text-muted-foreground text-xs uppercase">Entities</p><p className="text-muted-foreground">{brief.spec.entities.join(", ") || "—"}</p></div>
                  <div><p className="text-muted-foreground text-xs uppercase">Internal links</p><ul className="text-muted-foreground">{brief.spec.internalLinks.map((l) => <li key={l.url} className="truncate">{l.anchor} → {l.url}</li>)}{brief.spec.internalLinks.length === 0 ? <li>—</li> : null}</ul></div>
                </div>
                {brief.spec.bannedClaims.length ? <div><p className="text-muted-foreground text-xs uppercase">Must not claim</p><ul className="list-disc pl-5">{brief.spec.bannedClaims.map((b) => <li key={b}>{b}</li>)}</ul></div> : null}
              </CardContent>
            </Card>
          ) : null}

          {version ? (
            <Card>
              <CardHeader>
                <CardTitle>Draft v{version.version_no} · {version.word_count} words</CardTitle>
                <CardDescription>Rendered in your theme, exactly as it would publish. Nothing here is indexable.</CardDescription>
              </CardHeader>
              <CardContent>
                <iframe title="Draft preview" src={`/app/preview/${version.id}`} className="h-[70vh] w-full rounded-md border bg-white" sandbox="" />
                <p className="text-muted-foreground mt-2 text-xs"><a className="underline-offset-2 hover:underline" href={`/app/preview/${version.id}`} target="_blank" rel="noreferrer">Open in a new tab</a></p>
              </CardContent>
            </Card>
          ) : null}

          {editor && !decided ? (
            <Card>
              <CardHeader><CardTitle>Your decision</CardTitle><CardDescription>Approving a draft publishes it. Regenerate re-runs this stage with your note; request changes keeps the gate open.</CardDescription></CardHeader>
              <CardContent><DecisionForm approvalId={approval.id} kind={approval.kind} sections={sections} /></CardContent>
            </Card>
          ) : null}
        </div>

        <aside className="grid content-start gap-4">
          {version ? (
            <Card>
              <CardHeader><CardTitle>Quality gates</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm">
                {qa.length === 0 ? <p className="text-muted-foreground">No gate results recorded.</p> : qa.map((g) => (
                  <div key={g.gate} className="flex items-start justify-between gap-2">
                    <span className="font-mono text-xs">{g.gate}</span>
                    <Badge variant={g.passed ? "success" : "destructive"}>{g.passed ? "pass" : "fail"}</Badge>
                  </div>
                ))}
                {version.structure_score ? <p className="text-muted-foreground text-xs">Structure score: {Object.entries(version.structure_score).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${v}`).join(" · ") || "recorded"}</p> : null}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Brand facts cited</CardTitle><CardDescription>Only verified, currently effective facts pass the grounding gate.</CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {(version ? facts.map((f) => ({ key: f.key, text: f.text })) : (brief?.spec.facts ?? []).map((f) => ({ key: f.key, text: f.text }))).map((f) => (
                <div key={f.key}><span className="font-mono text-xs">{`{{fact:${f.key}}}`}</span><p>{f.text}</p></div>
              ))}
              {(version ? facts.length : brief?.spec.facts.length ?? 0) === 0 ? <p className="text-muted-foreground">None. This piece makes no company-specific claims.</p> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Sources</CardTitle><CardDescription>Every statistic must trace to one of these; the fact-check gate re-fetches the quote.</CardDescription></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {(version ? sources : brief?.spec.sources ?? []).map((s) => (
                <div key={s.url} className="min-w-0">
                  <a className="truncate underline-offset-2 hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
                  {"quote" in s && s.quote ? <p className="text-muted-foreground line-clamp-2 text-xs">“{String(s.quote)}”</p> : null}
                </div>
              ))}
              {(version ? sources.length : brief?.spec.sources.length ?? 0) === 0 ? <p className="text-muted-foreground">No external sources.</p> : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </AppShell>
  );
}
