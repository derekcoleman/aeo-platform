import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { MineForm } from "@/components/app/demand-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { demandCounts, listSiteQuestions, serpSpendSummary } from "@/lib/app/demand";
import { setTrackingAction, snapshotNowAction, trackTopAction } from "@/lib/app/demand-actions";
import { loadSite } from "@/lib/app/store";
import { canEdit, requireUser, roleIn } from "@/lib/auth/session";
import { listEntities } from "@/lib/context/entities";
import { citationGaps, visibilitySummary } from "@/lib/demand/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIERS = ["daily", "weekly", "monthly", "none"] as const;

export default async function DemandPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}/demand`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const editor = canEdit(user, site.org_id);
  const [counts, questions, gaps, visibility, spend, entities] = await Promise.all([
    demandCounts(siteId),
    listSiteQuestions(siteId, { limit: 150 }),
    citationGaps(siteId, 30),
    visibilitySummary(siteId),
    serpSpendSummary(site.org_id, siteId),
    listEntities(site.org_id),
  ]);
  const seeds = entities.filter((e) => e.type === "brand" || e.type === "product" || e.type === "competitor" || e.type === "category").map((e) => e.name).slice(0, 12);
  const providerConfigured = !!(process.env.DATAFORSEO_LOGIN || process.env.SERPAPI_KEY);
  const budgetPct = spend.budget_usd > 0 ? Math.min(100, Math.round((spend.org_month_usd / spend.budget_usd) * 100)) : 0;
  const share = visibility.aio_triggered ? Math.round((visibility.aio_cited / visibility.aio_triggered) * 100) : 0;

  return (
    <AppShell user={user} active="projects">
      <PageHeader title={`${site.name} · Demand & AI Overviews`} description="What buyers actually ask, phrased how they ask it, and whether an AI Overview cites you when they do.">
        <Badge variant="secondary">{counts.questions} questions</Badge>
        <Badge variant="secondary">{counts.tracked} tracked</Badge>
        <Badge variant={budgetPct >= 90 ? "destructive" : "outline"}>SERP spend ${spend.org_month_usd.toFixed(2)} / ${spend.budget_usd.toFixed(0)}</Badge>
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${siteId}` as Route}>Back to project</Link></Button>
      </PageHeader>

      {!providerConfigured ? (
        <Alert variant="warning" className="mb-4">
          <AlertTitle>No SERP provider configured</AlertTitle>
          <AlertDescription>Set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (cheap bulk autocomplete and PAA) and SERPAPI_KEY (AI Overview citations) to enable mining and snapshots. Everything below still reads what has already been collected.</AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardDescription>Tracked questions</CardDescription><CardTitle className="text-3xl tabular-nums">{visibility.questions_tracked}</CardTitle></CardHeader><CardContent className="text-muted-foreground text-xs">{counts.daily} daily · {counts.weekly} weekly · {counts.monthly} monthly</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>AI Overview triggers</CardDescription><CardTitle className="text-3xl tabular-nums">{visibility.aio_triggered}</CardTitle></CardHeader><CardContent className="text-muted-foreground text-xs">of the latest snapshot per question</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Cited in the AI Overview</CardDescription><CardTitle className="text-3xl tabular-nums">{visibility.aio_cited} <span className="text-muted-foreground text-base font-normal">({share}%)</span></CardTitle></CardHeader><CardContent className="text-muted-foreground text-xs">native providers only; Profound is shown separately</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Top competitors cited</CardDescription><CardTitle className="text-base">{visibility.top_competitors.slice(0, 3).map((c) => `${c.domain} (${c.citations})`).join(", ") || "—"}</CardTitle></CardHeader><CardContent className="text-muted-foreground text-xs">{counts.snapshots_7d} snapshots in 7d</CardContent></Card>
      </div>

      <Tabs defaultValue={gaps.length ? "gaps" : counts.questions ? "questions" : "mine"}>
        <TabsList>
          <TabsTrigger value="gaps">Citation gaps {gaps.length ? <Badge variant="warning">{gaps.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="questions">Questions</TabsTrigger>
          <TabsTrigger value="mine">Mine</TabsTrigger>
        </TabsList>

        <TabsContent value="gaps" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Where a competitor is cited and you are not</CardTitle><CardDescription>The highest-value opportunity type in the product. These land in the opportunity queue automatically on each scan; start one from the project page.</CardDescription></CardHeader>
            <CardContent>
              {gaps.length === 0 ? <p className="text-muted-foreground text-sm">No gaps recorded yet. Track questions and take a snapshot.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Question</TableHead><TableHead>Demand</TableHead><TableHead>Cited instead</TableHead><TableHead>Snapshot</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {gaps.map((g) => (
                      <TableRow key={g.question_id}>
                        <TableCell className="max-w-md font-medium">{g.text}</TableCell>
                        <TableCell className="font-mono">{g.demand_score.toFixed(0)}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{g.competitor_domains.slice(0, 4).join(", ")}{g.competitor_domains.length > 4 ? ` +${g.competitor_domains.length - 4}` : ""}</TableCell>
                        <TableCell className="text-xs">{when(g.fetched_at)} · {g.provider}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="questions" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Question graph</CardTitle>
              <CardDescription>Tiers decide the snapshot cadence and the spend: daily for the money questions, weekly for the tracked set, monthly for the long tail.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {editor ? (
                <div className="flex flex-wrap gap-2">
                  <ActionButton size="sm" variant="outline" action={trackTopAction.bind(null, siteId, 50, "weekly")} done="Tracked">Track top 50 weekly</ActionButton>
                  <ActionButton size="sm" variant="outline" action={trackTopAction.bind(null, siteId, 10, "daily")} done="Tracked">Track top 10 daily</ActionButton>
                  <ActionButton size="sm" action={snapshotNowAction.bind(null, siteId)} done="Snapshot queued">Snapshot tracked now</ActionButton>
                </div>
              ) : null}
              {questions.length === 0 ? <p className="text-muted-foreground text-sm">Nothing mined yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Question</TableHead><TableHead>Source</TableHead><TableHead>Demand</TableHead><TableHead>AI Overview</TableHead><TableHead>Tier</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {questions.map((q) => (
                      <TableRow key={q.id}>
                        <TableCell className="max-w-md"><p className="font-medium">{q.text}</p><p className="text-muted-foreground text-xs">seen {q.seen_count}× · {when(q.last_seen_at)}</p></TableCell>
                        <TableCell><Badge variant="outline">{q.source}</Badge></TableCell>
                        <TableCell className="font-mono">{q.demand_score.toFixed(0)}</TableCell>
                        <TableCell className="text-xs">
                          {q.last_snapshot_at === null ? <span className="text-muted-foreground">no snapshot</span> : q.aio_triggered === null ? <span className="text-muted-foreground">provider could not tell</span> : q.aio_triggered ? (q.aio_owned ? <Badge variant="success">cited</Badge> : <Badge variant="warning">{q.competitor_count} others cited</Badge>) : <span className="text-muted-foreground">no AIO</span>}
                        </TableCell>
                        <TableCell>
                          {editor ? (
                            <span className="inline-flex gap-1">
                              {TIERS.filter((t) => t !== q.tracking_tier).map((t) => <ActionButton key={t} size="sm" variant="ghost" className="h-7 px-2 text-xs" action={setTrackingAction.bind(null, siteId, q.id, t)} done="Set">{t}</ActionButton>)}
                              <Badge variant={q.is_tracked ? "secondary" : "outline"}>{q.tracking_tier}</Badge>
                            </span>
                          ) : <Badge variant={q.is_tracked ? "secondary" : "outline"}>{q.tracking_tier}</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mine" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Mine a question graph</CardTitle><CardDescription>Autocomplete expansion two levels deep plus the People-Also-Ask tree, deduped by embedding and clustered. Seeds come from the brand brain when it has them.</CardDescription></CardHeader>
            <CardContent>{editor ? <MineForm siteId={siteId} suggestedSeeds={seeds} /> : <p className="text-muted-foreground text-sm">Editors and above can mine.</p>}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Spend this month</CardTitle><CardDescription>Cached by (query, locale, device, day); the budget guard stops calls before the limit, never after.</CardDescription></CardHeader>
            <CardContent className="text-sm">
              <p>This project: <span className="font-mono">${spend.site_month_usd.toFixed(2)}</span> across {spend.calls_month} calls ({spend.cached_month} served from cache).</p>
              <p>Organisation: <span className="font-mono">${spend.org_month_usd.toFixed(2)}</span> of <span className="font-mono">${spend.budget_usd.toFixed(2)}</span> ({budgetPct}%). Change the budget in <Link className="underline-offset-2 hover:underline" href={`/app/orgs/${site.org_id}` as Route}>organisation settings</Link>.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
