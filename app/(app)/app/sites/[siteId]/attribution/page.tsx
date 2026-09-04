import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { assetAttribution, signalsAgreeing, siteSignals } from "@/lib/app/attribution";
import { loadSite } from "@/lib/app/store";
import { requireUser, roleIn } from "@/lib/auth/session";
import { visibilitySummary } from "@/lib/demand/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function delta(now: number, before: number): string {
  if (before === 0) return now > 0 ? "new" : "—";
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export default async function AttributionPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}/attribution`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const [assets, signals, visibility] = await Promise.all([assetAttribution(siteId), siteSignals(siteId), visibilitySummary(siteId)]);
  const agreeing = assets.filter((a) => signalsAgreeing(a) >= 2).length;
  return (
    <AppShell user={user} active="projects">
      <PageHeader title={`${site.name} · Attribution`} description="Three independent signals per published asset. A claim needs at least two of them to agree; one alone is a vanity metric.">
        <Badge variant="secondary">{assets.length} published</Badge>
        <Badge variant={agreeing ? "success" : "outline"}>{agreeing} with 2+ signals</Badge>
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${siteId}` as Route}>Back to project</Link></Button>
      </PageHeader>

      {!signals.has_ga4 && !signals.has_gsc ? (
        <Alert className="mb-4">
          <AlertTitle>Connect Google for the third signal</AlertTitle>
          <AlertDescription>Search Console gives clicks and impressions per page; GA4 gives sessions referred by chatgpt.com, perplexity.ai, gemini.google.com and copilot.microsoft.com. Without them only citations and crawler fetches are shown.</AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>AI Overview citations</CardDescription><CardTitle className="text-3xl tabular-nums">{visibility.aio_cited}</CardTitle></CardHeader>
          <CardContent className="text-muted-foreground text-xs">of {visibility.aio_triggered} questions with an AI Overview · native providers</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Live crawler fetches, 30d</CardDescription><CardTitle className="text-3xl tabular-nums">{signals.live_fetch_30d} <span className="text-muted-foreground text-base font-normal">{delta(signals.live_fetch_30d, signals.live_fetch_prev_30d)}</span></CardTitle></CardHeader>
          <CardContent className="text-muted-foreground text-xs">models reading your pages mid-answer · vs previous 30d</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>AI-referred sessions, 30d</CardDescription><CardTitle className="text-3xl tabular-nums">{Math.round(signals.ai_sessions_30d)} <span className="text-muted-foreground text-base font-normal">{delta(signals.ai_sessions_30d, signals.ai_sessions_prev_30d)}</span></CardTitle></CardHeader>
          <CardContent className="text-muted-foreground text-xs">{signals.has_ga4 ? "GA4 referrals from AI assistants" : "GA4 not connected"} · {signals.has_gsc ? `${Math.round(signals.gsc_clicks_28d)} Search Console clicks / 28d` : "GSC not connected"}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Per asset</CardTitle><CardDescription>Citations compare the 30 days after publish with the 30 days before, on the same tracked questions. Fetches and sessions are last 30 days.</CardDescription></CardHeader>
        <CardContent>
          {assets.length === 0 ? <p className="text-muted-foreground text-sm">Nothing published yet.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Asset</TableHead><TableHead>Published</TableHead><TableHead className="text-right">AIO questions cited (before → now)</TableHead><TableHead className="text-right">Live fetches 7d / 30d</TableHead><TableHead className="text-right">AI sessions</TableHead><TableHead className="text-right">GSC clicks / impr.</TableHead><TableHead>Signals</TableHead></TableRow></TableHeader>
              <TableBody>
                {assets.map((a) => {
                  const n = signalsAgreeing(a);
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="max-w-sm"><p className="truncate font-medium">{a.title ?? a.slug}</p>{a.path ? <a className="text-muted-foreground font-mono text-xs underline-offset-2 hover:underline" href={`https://${site.canonical_domain}${a.path}`} target="_blank" rel="noreferrer">{a.path}</a> : null}</TableCell>
                      <TableCell>{when(a.published_at)}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.aio_questions_baseline} → {a.aio_questions_30d}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.live_fetch_7d} / {a.live_fetch_30d}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(a.ai_sessions_30d)}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(a.gsc_clicks_28d)} / {Math.round(a.gsc_impressions_28d)}</TableCell>
                      <TableCell><Badge variant={n >= 2 ? "success" : n === 1 ? "warning" : "outline"}>{n} of 3</Badge></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
