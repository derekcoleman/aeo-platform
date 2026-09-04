import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { ContentRequestForm, EditTopic, ProfoundConnectForm, PromptForm, TopicForm } from "@/components/app/strategy-forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { loadSite } from "@/lib/app/store";
import { competitorDomains, listPrompts, profoundByEngine, profoundByTopic, profoundConnection } from "@/lib/app/strategy";
import { analyzeCompetitorsAction, assignTopicsAction, setQuestionFlagAction, setTopicStatusAction } from "@/lib/app/strategy-actions";
import { canEdit, canManage, requireUser, roleIn } from "@/lib/auth/session";
import { listCompetitorPages, structuralTargetFrom } from "@/lib/strategy/competitors";
import { listTopics, topicStats } from "@/lib/strategy/topics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

export default async function StrategyPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ topic?: string }> }) {
  const { siteId } = await params;
  const { topic: topicFilter } = await searchParams;
  const user = await requireUser(`/app/sites/${siteId}/strategy`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const editor = canEdit(user, site.org_id);
  const manager = canManage(user, site.org_id);
  const [topics, stats, prompts, pages, domains, engines, byTopic, profound] = await Promise.all([
    listTopics(siteId, undefined, true),
    topicStats(siteId),
    listPrompts(siteId, { topicId: topicFilter ?? null, limit: 200 }),
    listCompetitorPages(siteId, { topicId: topicFilter ?? null, limit: 40 }),
    competitorDomains(siteId, { topicId: topicFilter ?? null }),
    profoundByEngine(siteId),
    profoundByTopic(siteId),
    profoundConnection(siteId, site.org_id),
  ]);
  const target = structuralTargetFrom(pages);
  const topicName = (id: string | null) => topics.find((t) => t.id === id)?.name ?? null;
  const activeTopics = topics.filter((t) => t.status !== "archived");

  return (
    <AppShell user={user} active="projects">
      <PageHeader title={`${site.name} · Strategy`} description="What you want to be known for, what buyers ask about it, who gets cited instead of you, and what their content looks like. Everything here steers the queue and the briefs.">
        <Badge variant="secondary">{activeTopics.length} topics</Badge>
        <Badge variant="secondary">{prompts.filter((p) => p.is_tracked && !p.excluded).length} tracked prompts</Badge>
        {profound ? <Badge variant={profound.status === "active" ? "success" : "destructive"}>Profound {profound.mode}</Badge> : <Badge variant="outline">Profound not connected</Badge>}
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${siteId}` as Route}>Back to project</Link></Button>
      </PageHeader>

      {topicFilter ? <p className="text-muted-foreground mb-3 text-sm">Filtered to topic <span className="font-medium">{topicName(topicFilter) ?? topicFilter}</span> · <Link className="underline-offset-2 hover:underline" href={`/app/sites/${siteId}/strategy` as Route}>show all</Link></p> : null}

      <Tabs defaultValue={activeTopics.length ? "topics" : "topics"}>
        <TabsList>
          <TabsTrigger value="topics">Topics</TabsTrigger>
          <TabsTrigger value="prompts">Prompts & questions</TabsTrigger>
          <TabsTrigger value="competitors">Competitors</TabsTrigger>
          <TabsTrigger value="visibility">Visibility</TabsTrigger>
        </TabsList>

        <TabsContent value="topics" className="grid gap-4 pt-4">
          {activeTopics.length === 0 ? (
            <Alert>
              <AlertTitle>Start with two or three topics</AlertTitle>
              <AlertDescription>A topic is what you want AI answers to associate you with. Priority weights the queue, cadence caps how much we write, seed terms attach the questions we mine, and the formats decide what the brief asks for.</AlertDescription>
            </Alert>
          ) : null}
          {topics.map((t) => {
            const s = stats.get(t.id);
            const pf = byTopic.get(t.id);
            return (
              <Card key={t.id} className={t.status !== "active" ? "opacity-70" : undefined}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <Link className="underline-offset-2 hover:underline" href={`/app/sites/${siteId}/strategy?topic=${t.id}` as Route}>{t.name}</Link>
                    <Badge variant={t.status === "active" ? "success" : "outline"}>{t.status}</Badge>
                    <Badge variant="secondary">priority {t.priority}</Badge>
                    <Badge variant="secondary">{t.cadence_per_month}/month</Badge>
                    {t.formats.map((f) => <Badge key={f} variant="outline">{f}</Badge>)}
                  </CardTitle>
                  <CardDescription>{t.description || "No description."} {t.seed_terms.length ? `Seeds: ${t.seed_terms.join(", ")}.` : ""} {t.competitor_domains.length ? `Watching: ${t.competitor_domains.join(", ")}.` : ""}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <div className="grid gap-2 text-sm sm:grid-cols-4">
                    <div><p className="text-muted-foreground text-xs">Questions · tracked</p><p className="font-medium tabular-nums">{s?.questions ?? 0} · {s?.tracked ?? 0}</p></div>
                    <div><p className="text-muted-foreground text-xs">AI Overview cited (native)</p><p className="font-medium tabular-nums">{s?.aio_cited ?? 0} of {s?.aio_triggered ?? 0} · {s?.gaps ?? 0} gaps</p></div>
                    <div><p className="text-muted-foreground text-xs">Profound mention rate · visibility</p><p className="font-medium tabular-nums">{pf ? `${pct(pf.mention_rate)} · ${pf.visibility === null ? "—" : Math.round(pf.visibility)}` : "—"}</p></div>
                    <div><p className="text-muted-foreground text-xs">Published · this month · queued</p><p className="font-medium tabular-nums">{s?.published ?? 0} · {s?.published_30d ?? 0}/{t.cadence_per_month} · {s?.open_opportunities ?? 0}</p></div>
                  </div>
                  {editor ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <EditTopic siteId={siteId} topic={t} />
                      {t.status === "active" ? <ActionButton size="sm" variant="ghost" action={setTopicStatusAction.bind(null, siteId, t.id, "paused")} done="Paused">Pause</ActionButton> : <ActionButton size="sm" variant="ghost" action={setTopicStatusAction.bind(null, siteId, t.id, "active")} done="Active">Activate</ActionButton>}
                      {t.status !== "archived" ? <ActionButton size="sm" variant="ghost" action={setTopicStatusAction.bind(null, siteId, t.id, "archived")} done="Archived">Archive</ActionButton> : null}
                      <ActionButton size="sm" variant="ghost" action={analyzeCompetitorsAction.bind(null, siteId, t.id)} done="Analysis queued">Analyse competitors</ActionButton>
                      <ContentRequestForm siteId={siteId} topics={activeTopics} defaultTopicId={t.id} compact />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
          {editor ? (
            <Card>
              <CardHeader><CardTitle>New topic</CardTitle></CardHeader>
              <CardContent><TopicForm siteId={siteId} /></CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="prompts" className="grid gap-4 pt-4">
          {editor ? (
            <Card>
              <CardHeader><CardTitle>Add prompts to track</CardTitle><CardDescription>Exact phrasings you care about, from sales calls or your own judgement. Tracked immediately and pinned so scans never drop them.</CardDescription></CardHeader>
              <CardContent><PromptForm siteId={siteId} topics={activeTopics} /></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Prompts & questions</CardTitle>
              <CardDescription>Pin to keep, exclude to drop from scans and briefs without losing history, move between topics. “Write about this” queues a piece for that prompt.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {editor ? <div><ActionButton size="sm" variant="outline" action={assignTopicsAction.bind(null, siteId)} done="Assigned">Re-assign by seed terms</ActionButton></div> : null}
              {prompts.length === 0 ? <p className="text-muted-foreground text-sm">Nothing yet. Add prompts above or mine questions on the Demand page.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Prompt</TableHead><TableHead>Topic</TableHead><TableHead>Native AIO</TableHead><TableHead>Profound</TableHead><TableHead>Tier</TableHead><TableHead></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {prompts.map((p) => (
                      <TableRow key={p.id} className={p.excluded ? "opacity-50" : undefined}>
                        <TableCell className="max-w-md"><p className="font-medium">{p.pinned ? "📌 " : ""}{p.text}</p><p className="text-muted-foreground text-xs">{p.source} · demand {p.demand_score.toFixed(0)}{p.excluded ? " · excluded" : ""}</p></TableCell>
                        <TableCell className="text-xs">{topicName(p.topic_id) ?? <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-xs">{p.aio_triggered === null ? <span className="text-muted-foreground">no snapshot</span> : !p.aio_triggered ? <span className="text-muted-foreground">no AIO</span> : p.aio_owned ? <Badge variant="success">cited</Badge> : <span><Badge variant="warning">gap</Badge> <span className="text-muted-foreground">{p.competitor_domains.slice(0, 3).join(", ")}</span></span>}</TableCell>
                        <TableCell className="text-xs">{p.profound_mention_rate === null ? <span className="text-muted-foreground">—</span> : `${pct(p.profound_mention_rate)} mentioned${p.profound_visibility !== null ? ` · vis ${Math.round(p.profound_visibility)}` : ""}`}</TableCell>
                        <TableCell><Badge variant={p.is_tracked && !p.excluded ? "secondary" : "outline"}>{p.excluded ? "off" : p.tracking_tier}</Badge></TableCell>
                        <TableCell className="text-right">
                          {editor ? (
                            <span className="inline-flex flex-wrap justify-end gap-1">
                              <ActionButton size="sm" variant="ghost" className="h-7 px-2 text-xs" action={setQuestionFlagAction.bind(null, siteId, p.id, { pinned: !p.pinned })} done="Done">{p.pinned ? "Unpin" : "Pin"}</ActionButton>
                              <ActionButton size="sm" variant="ghost" className="h-7 px-2 text-xs" action={setQuestionFlagAction.bind(null, siteId, p.id, { excluded: !p.excluded })} done="Done">{p.excluded ? "Include" : "Exclude"}</ActionButton>
                              {activeTopics.filter((t) => t.id !== p.topic_id).slice(0, 3).map((t) => <ActionButton key={t.id} size="sm" variant="ghost" className="h-7 px-2 text-xs" action={setQuestionFlagAction.bind(null, siteId, p.id, { topicId: t.id })} done="Moved">→ {t.name.slice(0, 18)}</ActionButton>)}
                              {!p.excluded ? <ContentRequestForm siteId={siteId} topics={activeTopics} defaultTitle={p.text} questionId={p.id} defaultTopicId={p.topic_id} compact /> : null}
                            </span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="competitors" className="grid gap-4 pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Who gets cited instead of you</CardTitle><CardDescription>AI Overview citations, last 30 days, native and Profound sources labelled.</CardDescription></CardHeader>
              <CardContent>
                {domains.length === 0 ? <p className="text-muted-foreground text-sm">No competitor citations recorded yet.</p> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Domain</TableHead><TableHead className="text-right">Citations</TableHead><TableHead className="text-right">Prompts</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
                    <TableBody>{domains.map((d) => <TableRow key={d.domain}><TableCell className="font-medium">{d.domain}</TableCell><TableCell className="text-right tabular-nums">{d.citations}</TableCell><TableCell className="text-right tabular-nums">{d.questions}</TableCell><TableCell className="text-xs">{d.providers.join(", ")}</TableCell></TableRow>)}</TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>What their content looks like</CardTitle><CardDescription>Cited pages fetched and scored with the same rules the audit and the linter use. This is the structural target every brief is told to beat.</CardDescription></CardHeader>
              <CardContent className="grid gap-2 text-sm">
                {editor ? <div><ActionButton size="sm" variant="outline" action={analyzeCompetitorsAction.bind(null, siteId, topicFilter ?? null)} done="Analysis queued">Analyse cited pages now</ActionButton></div> : null}
                {target.pages === 0 ? <p className="text-muted-foreground">No pages analysed yet.</p> : (
                  <>
                    <p><span className="text-muted-foreground">Dominant format:</span> <span className="font-medium">{target.dominantType}</span> ({Object.entries(target.typeShare).map(([k, v]) => `${k} ${v}%`).join(", ")})</p>
                    <p><span className="text-muted-foreground">Median length:</span> {target.medianWords} words · <span className="text-muted-foreground">comparison table:</span> {target.tablePct}% · <span className="text-muted-foreground">FAQ block:</span> {target.faqPct}% · <span className="text-muted-foreground">question headings:</span> {target.questionHeadingPct}%</p>
                    {target.medianStructureScore !== null ? <p><span className="text-muted-foreground">Median structure score:</span> {target.medianStructureScore}</p> : null}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Cited pages</CardTitle></CardHeader>
            <CardContent>
              {pages.length === 0 ? <p className="text-muted-foreground text-sm">Nothing analysed yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Topic</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Words</TableHead><TableHead className="text-right">Structure</TableHead><TableHead className="text-right">Cited 30d</TableHead><TableHead>Fetched</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {pages.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="max-w-md"><a className="truncate font-medium underline-offset-2 hover:underline" href={p.url} target="_blank" rel="noreferrer">{p.title ?? p.url}</a><p className="text-muted-foreground font-mono text-xs">{p.domain}</p>{p.fetch_error ? <p className="text-destructive text-xs">{p.fetch_error}</p> : null}</TableCell>
                        <TableCell className="text-xs">{topicName(p.topic_id) ?? "—"}</TableCell>
                        <TableCell><Badge variant="outline">{p.content_type}</Badge></TableCell>
                        <TableCell className="text-right tabular-nums">{p.word_count || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.structure_score?.normalized ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.citations_30d}</TableCell>
                        <TableCell className="text-xs">{when(p.fetched_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="visibility" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Profound {profound ? <Badge variant={profound.status === "active" ? "success" : "destructive"}>{profound.status} · {profound.mode}</Badge> : null}</CardTitle>
              <CardDescription>{profound ? `${profound.category ?? "category"} · last sync ${when(profound.last_synced_at)}${profound.last_error ? ` · ${profound.last_error.slice(0, 120)}` : ""}` : "Profound tracks where you and competitors appear across ChatGPT, Perplexity, Gemini and Copilot. Connect the Enterprise API to pull it in; every number from it is labelled as Profound's."}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {engines.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Platform</TableHead><TableHead className="text-right">Prompts</TableHead><TableHead className="text-right">Answers 30d</TableHead><TableHead className="text-right">Mentioned</TableHead><TableHead className="text-right">Visibility</TableHead><TableHead className="text-right">We are cited</TableHead></TableRow></TableHeader>
                  <TableBody>{engines.map((e) => <TableRow key={e.engine}><TableCell className="font-medium">{e.engine}</TableCell><TableCell className="text-right tabular-nums">{e.prompts}</TableCell><TableCell className="text-right tabular-nums">{e.answers}</TableCell><TableCell className="text-right tabular-nums">{pct(e.mention_rate)}</TableCell><TableCell className="text-right tabular-nums">{e.visibility === null ? "—" : Math.round(e.visibility)}</TableCell><TableCell className="text-right tabular-nums">{pct(e.owned_citation_rate)}</TableCell></TableRow>)}</TableBody>
                </Table>
              ) : <p className="text-muted-foreground text-sm">No Profound data in the last 30 days.</p>}
              {manager && (!profound || profound.mode !== "api") ? <ProfoundConnectForm siteId={siteId} /> : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
