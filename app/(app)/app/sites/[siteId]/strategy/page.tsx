import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionButton } from "@/components/app/action-button";
import { AnswerEngines, AnswerEnginesLoading } from "@/components/app/answer-engines";
import { LiveRefresh } from "@/components/app/live-refresh";
import { CompetitorDomainsLoading, NamedCompetitors, SourcesShapingAnswers } from "@/components/app/competitor-domains";
import { CompetitorGapLoading, CompetitorKeywordGap } from "@/components/app/competitor-gap";
import { MethodologyNote } from "@/components/app/methodology-note";
import { AppShell, PageHeader } from "@/components/app/shell";
import { SyncStatus } from "@/components/app/sync-status";
import { when } from "@/components/app/status";
import { CompetitorForm, ContentRequestForm, EditTopic, KeywordsForm, ProfoundConnectForm, PromptForm, TopicForm } from "@/components/app/strategy-forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/app/url-tabs";
import { resolveTab, settingsHref, sitePage } from "@/lib/app/nav";
import { currentRestatements, METHODOLOGY_PAGE_METRICS } from "@/lib/app/methodology";
import { loadSite } from "@/lib/app/store";
import { listPrompts, profoundByEngine, profoundByTopic, profoundConnection } from "@/lib/app/strategy";
import { analyzeCompetitorGapAction, analyzeCompetitorsAction, assignTopicsAction, setQuestionFlagAction, setTopicStatusAction, syncConnectionNowAction } from "@/lib/app/strategy-actions";
import { canEdit, canManage, requireUser, roleIn } from "@/lib/auth/session";
import { latestSyncRun } from "@/lib/connectors/store";
import { describeSyncState } from "@/lib/connectors/sync-status";
import { listCompetitorPages, structuralTargetFrom } from "@/lib/strategy/competitors";
import { listTopics, topicStats } from "@/lib/strategy/topics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

export default async function StrategyPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ topic?: string; tab?: string }> }) {
  const { siteId } = await params;
  const { topic: topicFilter, tab: requestedTab } = await searchParams;
  const user = await requireUser(`/app/sites/${siteId}/strategy`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const editor = canEdit(user, site.org_id);
  const manager = canManage(user, site.org_id);
  const [topics, stats, prompts, pages, engines, byTopic, profound, restated] = await Promise.all([
    listTopics(siteId, undefined, true),
    topicStats(siteId),
    listPrompts(siteId, { topicId: topicFilter ?? null, limit: 200 }),
    listCompetitorPages(siteId, { topicId: topicFilter ?? null, limit: 40 }),
    profoundByEngine(siteId),
    profoundByTopic(siteId),
    profoundConnection(siteId, site.org_id),
    currentRestatements(siteId, METHODOLOGY_PAGE_METRICS.strategy),
  ]);
  const latestRun = profound ? await latestSyncRun(profound.id) : null;
  const sync = profound && profound.mode === "api" ? describeSyncState({ now: new Date(), requestedAt: profound.sync_requested_at, requestedKind: profound.sync_requested_kind, latestRun }) : null;
  const target = structuralTargetFrom(pages);
  const topicName = (id: string | null) => topics.find((t) => t.id === id)?.name ?? null;
  const activeTopics = topics.filter((t) => t.status !== "archived");
  const sections = sitePage("strategy").sections!;
  const tab = resolveTab(sections, requestedTab, "topics");

  return (
    <AppShell user={user} site={site} page="strategy" section={tab}>
      <PageHeader title="Strategy" eyebrow={site.name} description="What you want to be known for, what buyers ask about it, who gets cited instead of you, and what their content looks like. Everything here steers the queue and the briefs.">
        <Badge variant="secondary">{activeTopics.length} topics</Badge>
        <Badge variant="secondary">{prompts.filter((p) => p.is_tracked && !p.excluded).length} tracked prompts</Badge>
        {profound ? <Badge variant={profound.status === "active" ? "success" : "destructive"}>Profound {profound.mode}</Badge> : <Badge variant="outline">Profound not connected</Badge>}
      </PageHeader>

      <MethodologyNote rows={restated} />

      {topicFilter ? <p className="text-muted-foreground mb-3 text-sm">Filtered to topic <span className="font-medium">{topicName(topicFilter) ?? topicFilter}</span> · <Link className="underline-offset-2 hover:underline" href={`/app/sites/${siteId}/strategy` as Route}>show all</Link></p> : null}

      <UrlTabs defaultValue="topics" values={sections.map((s) => s.value)}>
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
            <>
            <Card>
              <CardHeader><CardTitle>Add keywords</CardTitle><CardDescription>The quick way: paste a list and each keyword becomes a topic with itself as the seed term. Refine priority, cadence and formats on the topic afterwards.</CardDescription></CardHeader>
              <CardContent><KeywordsForm siteId={siteId} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>New topic</CardTitle></CardHeader>
              <CardContent><TopicForm siteId={siteId} /></CardContent>
            </Card>
            </>
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
              <CardHeader><CardTitle>Competitors</CardTitle><CardDescription>The rivals you name, and how often each was cited in Google AI Overviews instead of you, from our own trackers, last 30 days{profound ? "; Profound's engines in their own column" : ""}. A competitor&apos;s subdomains count as it. Only these count as competitors in the queue&apos;s scores.</CardDescription></CardHeader>
              <CardContent className="grid gap-4">
                <Suspense fallback={<CompetitorDomainsLoading />}>
                  <NamedCompetitors siteId={siteId} topicId={topicFilter ?? null} profound={!!profound} editor={editor} />
                </Suspense>
                {editor ? (
                  <details>
                    <summary className="text-muted-foreground cursor-pointer text-sm">Add a competitor</summary>
                    <div className="mt-3"><CompetitorForm siteId={siteId} /></div>
                  </details>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>What their content looks like</CardTitle><CardDescription>Cited pages fetched and scored with the same rules the audit and the linter use; forums, review sites, wikis, social, video, directories and marketplaces are left out. This is the structural target every brief is told to beat.</CardDescription></CardHeader>
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
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">Keywords they rank for that you don&apos;t <Badge variant="outline">Organic rankings · DataForSEO Labs</Badge></CardTitle>
              <CardDescription>Keywords where a named competitor ranks in Google&apos;s organic top 10 and you do not{topicFilter ? ", this topic only" : ""}, found on the 2nd of each month for up to five competitor domains. Keywords that name a competitor are left out unless they compare. Where you already rank 11–20 the page that ranks is the one to improve, and the queue sends the work there. The best of the rest are on the queue already. Organic rankings, not AI answers: never added to the AI Overview numbers on this page.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {editor ? <div><ActionButton size="sm" variant="outline" action={analyzeCompetitorGapAction.bind(null, siteId)} done="Queued">Find keyword gaps now</ActionButton></div> : null}
              <Suspense fallback={<CompetitorGapLoading />}>
                <CompetitorKeywordGap siteId={siteId} locale={site.locale} topicId={topicFilter ?? null} topics={activeTopics} editor={editor} />
              </Suspense>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Sources shaping answers</CardTitle><CardDescription>Sites cited in AI Overviews that are neither yours nor a competitor, last 30 days{profound ? "; Profound's engines listed separately below" : ""}: forums, review platforms, publishers, reference sites, analysts. They are where to be mentioned, not who to beat. Change a site&apos;s role for this project if it is wrong, or mark it a competitor.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <Suspense fallback={<CompetitorDomainsLoading />}>
                <SourcesShapingAnswers siteId={siteId} topicId={topicFilter ?? null} profound={!!profound} editor={editor} />
              </Suspense>
            </CardContent>
          </Card>
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
              <CardTitle className="flex flex-wrap items-center gap-2">Engines <Badge variant="outline">API-grounded probes via OpenRouter</Badge></CardTitle>
              <CardDescription>How each AI engine&apos;s model answers your tracked prompts when we ask it through its API with web search on{topicFilter ? ", this topic only" : ""}. Our own probes, not the consumer apps, and never added to the Google AI Overview numbers or to Profound&apos;s below.</CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<AnswerEnginesLoading />}>
                <AnswerEngines siteId={siteId} orgId={site.org_id} topicId={topicFilter ?? null} />
              </Suspense>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Profound {profound ? <Badge variant={profound.status === "active" ? "success" : "destructive"}>{profound.status} · {profound.mode}</Badge> : null}</CardTitle>
              <CardDescription>{profound ? `${profound.category ?? "category"} · last successful sync ${when(profound.last_synced_at)}${profound.mode === "api" ? " · syncs daily at 05:00 UTC; the first sync backfills 90 days in 30-day windows" : ""}` : "Profound tracks where you and competitors appear across ChatGPT, Perplexity, Gemini and Copilot. Connect the Enterprise API to pull it in; every number from it is labelled as Profound's."}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {sync ? <SyncStatus state={sync} setupHref={user.isStaff ? settingsHref(site.id, null, "deployment") : null} /> : null}
              {sync ? <LiveRefresh active={sync.live} intervalMs={5000} maxMs={15 * 60 * 1000} /> : null}
              {engines.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Platform</TableHead><TableHead className="text-right">Prompts</TableHead><TableHead className="text-right">Answers 30d</TableHead><TableHead className="text-right">Mentioned</TableHead><TableHead className="text-right">Visibility</TableHead><TableHead className="text-right">We are cited</TableHead></TableRow></TableHeader>
                  <TableBody>{engines.map((e) => <TableRow key={e.engine}><TableCell className="font-medium">{e.engine}</TableCell><TableCell className="text-right tabular-nums">{e.prompts}</TableCell><TableCell className="text-right tabular-nums">{e.answers}</TableCell><TableCell className="text-right tabular-nums">{pct(e.mention_rate)}</TableCell><TableCell className="text-right tabular-nums">{e.visibility === null ? "—" : Math.round(e.visibility)}</TableCell><TableCell className="text-right tabular-nums">{pct(e.owned_citation_rate)}</TableCell></TableRow>)}</TableBody>
                </Table>
              ) : <p className="text-muted-foreground text-sm">No Profound data in the last 30 days.</p>}
              {manager && profound && profound.mode === "api" && sync && (profound.status === "active" || profound.status === "error") ? (
                <div className="flex flex-wrap items-center gap-2">
                  <ActionButton size="sm" variant="outline" disabled={sync.live} action={syncConnectionNowAction.bind(null, siteId, profound.id)} done="Queued">
                    {sync.phase === "failed" || sync.phase === "stalled" || sync.phase === "lost" ? (profound.last_synced_at ? "Retry the sync" : "Retry the 90-day backfill") : profound.last_synced_at ? "Sync now" : "Run the 90-day backfill now"}
                  </ActionButton>
                  {sync.live ? <span className="text-muted-foreground text-xs">This page refreshes itself while the sync runs.</span> : null}
                </div>
              ) : null}
              {manager && (!profound || profound.mode !== "api") ? <ProfoundConnectForm siteId={siteId} /> : null}
            </CardContent>
          </Card>
        </TabsContent>
      </UrlTabs>
    </AppShell>
  );
}
