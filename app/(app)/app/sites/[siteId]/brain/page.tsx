import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { EntityForm, ManifestForm } from "@/components/app/brain-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FACT_TYPE_LABEL, brainCounts, brainSources, listManifests, listSignals } from "@/lib/app/brain";
import { activateManifestAction, dismissSignalAction, draftManifestAction, extractFactsAction, ingestNowAction, rejectFactAction, scanSignalsAction, verifyFactAction } from "@/lib/app/brain-actions";
import { loadSite } from "@/lib/app/store";
import { canManage, requireUser, roleIn } from "@/lib/auth/session";
import { listEntities } from "@/lib/context/entities";
import { listCandidateFacts, listVerifiedFacts, renderFact } from "@/lib/context/facts";
import { manifestDocSchema } from "@/lib/context/manifest";
import type { FactRow } from "@/lib/context/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function FactLine({ f }: { f: FactRow }) {
  return (
    <div className="min-w-0">
      <p className="text-sm">{renderFact(f)}</p>
      <p className="text-muted-foreground mt-1 flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">{FACT_TYPE_LABEL[f.type]}</Badge>
        <span>{f.visibility}</span>
        <span>confidence {Math.round(f.confidence * 100)}%</span>
        {f.effective_from ? <span>from {String(f.effective_from).slice(0, 10)}</span> : null}
      </p>
      {f.source_quote ? <blockquote className="text-muted-foreground mt-2 border-l-2 pl-3 text-xs italic">“{f.source_quote.slice(0, 280)}”</blockquote> : null}
    </div>
  );
}

export default async function BrainPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}/brain`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const orgId = site.org_id;
  const [counts, sources, candidates, verified, entities, manifests, signals] = await Promise.all([
    brainCounts(orgId),
    brainSources(orgId),
    listCandidateFacts(orgId, 40),
    listVerifiedFacts(orgId, { limit: 200 }),
    listEntities(orgId),
    listManifests(orgId),
    listSignals(orgId, siteId),
  ]);
  const manage = canManage(user, orgId);
  const active = manifests.find((m) => m.status === "active") ?? null;
  const brandName = entities.find((e) => e.type === "brand")?.name ?? site.name;
  const template = JSON.stringify(active?.doc ?? manifestDocSchema.parse({ brand: { name: brandName, oneLiner: "", category: "" } }), null, 2);
  const byType = new Map<string, FactRow[]>();
  for (const f of verified) byType.set(f.type, [...(byType.get(f.type) ?? []), f]);

  return (
    <AppShell user={user} active="projects">
      <PageHeader title={`${site.name} · Brand brain`} description="What the company actually knows: verified facts, named entities, and the manifesto every brief and draft is pinned to.">
        <Badge variant={counts.candidates ? "warning" : "secondary"}>{counts.candidates} to verify</Badge>
        <Badge variant="secondary">{counts.verified} verified</Badge>
        <Badge variant="secondary">{counts.entities} entities</Badge>
        <Badge variant="secondary">{counts.chunks} chunks</Badge>
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${siteId}` as Route}>Back to project</Link></Button>
      </PageHeader>

      <Tabs defaultValue={counts.candidates ? "verify" : "facts"}>
        <TabsList>
          <TabsTrigger value="verify">Verify {counts.candidates ? <Badge variant="warning">{counts.candidates}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="facts">Facts</TabsTrigger>
          <TabsTrigger value="entities">Entities</TabsTrigger>
          <TabsTrigger value="manifest">Manifesto</TabsTrigger>
          <TabsTrigger value="signals">Signals {counts.signals_new ? <Badge variant="secondary">{counts.signals_new}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
        </TabsList>

        <TabsContent value="verify" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Candidate facts</CardTitle>
              <CardDescription>Extracted from Slack, docs and calls. Only verified facts can be cited in a draft, so this is the highest-leverage human loop in the product. Reject anything wrong, stale or not yours to claim.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {candidates.length === 0 ? <p className="text-muted-foreground text-sm">Nothing waiting. Run an extraction after the next sync.</p> : candidates.map((f) => (
                <div key={f.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3">
                  <FactLine f={f} />
                  <div className="flex shrink-0 gap-2">
                    <ActionButton size="sm" action={verifyFactAction.bind(null, siteId, f.id)} done="Verified">Verify</ActionButton>
                    <ActionButton size="sm" variant="outline" action={rejectFactAction.bind(null, siteId, f.id, undefined)} done="Rejected">Reject</ActionButton>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="facts" className="grid gap-4 pt-4">
          {verified.length === 0 ? (
            <Alert>
              <AlertTitle>No verified facts yet</AlertTitle>
              <AlertDescription>Connect Slack or Google, sync, run an extraction, then verify the candidates. Until then drafts cannot make company-specific claims.</AlertDescription>
            </Alert>
          ) : [...byType.entries()].map(([type, rows]) => (
            <Card key={type}>
              <CardHeader><CardTitle>{FACT_TYPE_LABEL[type as FactRow["type"]] ?? type} <Badge variant="secondary">{rows.length}</Badge></CardTitle></CardHeader>
              <CardContent className="grid gap-3">{rows.map((f) => <FactLine key={f.id} f={f} />)}</CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="entities" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Entities</CardTitle><CardDescription>Products, features, competitors, customers, personas. Resolved by alias as whole words, never by substring, so “Notion” inside “notionally” never counts.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              {entities.length === 0 ? <p className="text-muted-foreground text-sm">No entities yet. The brand entity is created on first extraction; add competitors and products here.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Aliases</TableHead><TableHead>Wikidata</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {entities.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-medium">{e.name}{e.description ? <div className="text-muted-foreground text-xs">{e.description}</div> : null}</TableCell>
                        <TableCell><Badge variant="outline">{e.type}</Badge></TableCell>
                        <TableCell className="text-muted-foreground text-xs">{e.aliases.join(", ") || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{e.wikidata_id ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <EntityForm siteId={siteId} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manifest" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Manifesto {active ? <Badge variant="success">v{active.version} active</Badge> : <Badge variant="warning">none active</Badge>}</CardTitle>
              <CardDescription>Category POV, contrarian takes, ICP, voice do/don’t pairs, banned phrases, competitor stance, proof points, legal no-gos. Every brief and version records the manifest it was written under.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {active ? (
                <div className="grid gap-2 text-sm">
                  <p><span className="font-medium">{active.doc.brand.name}</span> — {active.doc.brand.oneLiner || <span className="text-muted-foreground">no one-liner</span>}</p>
                  {active.doc.categoryPov ? <p className="text-muted-foreground">{active.doc.categoryPov}</p> : null}
                  <p className="text-muted-foreground text-xs">{active.doc.icp.length} ICP personas · {active.doc.voice.pairs.length} voice pairs · {active.doc.bannedPhrases.length} banned phrases · {active.doc.competitors.length} competitors · {active.doc.proofPoints.length} proof points</p>
                </div>
              ) : null}
              {manage ? (
                <div className="flex flex-wrap gap-2">
                  <ActionButton variant="outline" action={draftManifestAction.bind(null, siteId)} done="Draft created below">Draft from verified facts</ActionButton>
                </div>
              ) : null}
              {manifests.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Version</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {manifests.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>v{m.version}{m.site_id ? <span className="text-muted-foreground text-xs"> · site</span> : null}</TableCell>
                        <TableCell><Badge variant={m.status === "active" ? "success" : m.status === "draft" ? "secondary" : "outline"}>{m.status}</Badge></TableCell>
                        <TableCell>{when(m.created_at)}</TableCell>
                        <TableCell className="text-right">{manage && m.status !== "active" ? <ActionButton size="sm" variant="outline" action={activateManifestAction.bind(null, siteId, m.id)} done="Activated">Activate</ActionButton> : null}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
              {manage ? <ManifestForm siteId={siteId} initial={template} /> : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="signals" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>What changed</CardTitle>
              <CardDescription>Deterministic detectors over everything ingested: term spikes, questions asked repeatedly with no published answer, competitor mention spikes. Unanswered questions become opportunities automatically.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div><ActionButton size="sm" variant="outline" action={scanSignalsAction.bind(null, siteId)} done="Scan queued">Scan now</ActionButton></div>
              {signals.length === 0 ? <p className="text-muted-foreground text-sm">No signals yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Signal</TableHead><TableHead>Kind</TableHead><TableHead>Score</TableHead><TableHead>Seen</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {signals.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="max-w-md truncate font-medium">{s.title}</TableCell>
                        <TableCell><Badge variant="outline">{s.kind}</Badge></TableCell>
                        <TableCell className="font-mono">{s.score.toFixed(0)}</TableCell>
                        <TableCell>{s.seen_count}× · {when(s.last_seen_at)}</TableCell>
                        <TableCell>{s.status}</TableCell>
                        <TableCell className="text-right">{s.status === "new" ? <ActionButton size="sm" variant="ghost" action={dismissSignalAction.bind(null, siteId, s.id)} done="Dismissed">Dismiss</ActionButton> : null}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sources" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Connected sources</CardTitle><CardDescription>Everything is redacted before it is chunked or embedded. Ingest runs after every sync; extraction needs a model key.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <ActionButton size="sm" variant="outline" action={ingestNowAction.bind(null, siteId)} done="Ingest queued">Ingest now</ActionButton>
                <ActionButton size="sm" variant="outline" action={extractFactsAction.bind(null, siteId)} done="Extraction queued">Extract facts</ActionButton>
                <Button asChild size="sm" variant="outline"><Link href={"/settings/connectors" as Route}>Manage connectors</Link></Button>
              </div>
              {sources.length === 0 ? <p className="text-muted-foreground text-sm">Nothing connected. Slack and Google are the first two; Profound CSV is enrichment.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Documents</TableHead><TableHead className="text-right">Chunked</TableHead><TableHead className="text-right">Facts run</TableHead><TableHead>Newest</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {sources.map((s) => (
                      <TableRow key={s.connection_id ?? s.provider}>
                        <TableCell className="font-medium">{s.provider}</TableCell>
                        <TableCell>{s.external_account_name ?? "—"}</TableCell>
                        <TableCell><Badge variant={s.status === "active" ? "success" : s.status === "error" ? "destructive" : "secondary"}>{s.status}</Badge>{s.last_error ? <div className="text-destructive text-xs">{s.last_error.slice(0, 80)}</div> : null}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.documents}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.chunked}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.facts_extracted}</TableCell>
                        <TableCell>{when(s.latest_source_ts)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
