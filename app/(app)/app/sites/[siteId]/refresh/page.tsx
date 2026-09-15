import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { UrlTabs } from "@/components/app/url-tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolveTab, sitePage } from "@/lib/app/nav";
import { listRefreshItems, refreshOverview, type RefreshItemRow } from "@/lib/app/refresh";
import { refreshItemAction, rescoreRefreshAction, syncInventoryAction } from "@/lib/app/refresh-actions";
import { loadSite } from "@/lib/app/store";
import { canEdit, canManage, requireUser, roleIn } from "@/lib/auth/session";
import { REFRESH_THRESHOLD } from "@/lib/refresh/score";
import { signalAvailability } from "@/lib/refresh/scan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-US"));
const day = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—");

function ageLabel(v: string | Date | null | undefined): string {
  if (!v) return "unknown";
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000);
  if (days < 45) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function delta(now: number, before: number): string | null {
  if (before <= 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function StateBadge({ i }: { i: RefreshItemRow }) {
  if (i.missing) return <Badge variant="outline">deleted in CMS</Badge>;
  if (i.is_archived) return <Badge variant="outline">archived</Badge>;
  if (i.is_draft) return <Badge variant="secondary">draft</Badge>;
  if (i.last_published) return <Badge variant="success">live</Badge>;
  return <Badge variant="secondary">staged</Badge>;
}

function RefreshState({ i }: { i: RefreshItemRow }) {
  if (i.pending_approval_id) return <Button asChild size="sm"><Link href={`/app/approvals/${i.pending_approval_id}` as Route}>Review</Link></Button>;
  if (i.opportunity_status === "queued" || i.opportunity_status === "in_progress") return <Badge variant="warning">refresh {i.opportunity_status.replace("_", " ")}</Badge>;
  return null;
}

export default async function RefreshPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { siteId } = await params;
  const { tab: requestedTab } = await searchParams;
  const user = await requireUser(`/app/sites/${siteId}/refresh`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const editor = canEdit(user, site.org_id);
  const manager = canManage(user, site.org_id);
  const [items, overview, avail] = await Promise.all([listRefreshItems(siteId), refreshOverview(siteId, site.org_id), signalAvailability(siteId)]);
  const sections = sitePage("refresh").sections!;
  const tab = resolveTab(sections, requestedTab, "candidates");
  const candidates = items.filter((i) => i.refresh_score !== null && !i.refresh_signals?.exclusion && i.refresh_score >= REFRESH_THRESHOLD);
  const connected = overview.connection?.status === "active";
  const collections = [...new Set(items.map((i) => i.collection_name))];

  return (
    <AppShell user={user} site={site} page="refresh" section={tab}>
      <PageHeader title="Refresh" eyebrow={site.name} description="Everything already in your CMS, joined with Search Console traffic and AI citations, ranked by how much a rewrite would recover. A refresh runs the same brief → draft → QA → approval loop and updates the post in place, same URL.">
        <Badge variant="secondary">{overview.items} items · {overview.collections} collections</Badge>
        <Badge variant={candidates.length ? "warning" : "outline"}>{candidates.length} need a refresh</Badge>
        {connected ? <Badge variant="success">Webflow synced {when(overview.lastSyncedAt)}</Badge> : <Badge variant="destructive">Webflow not connected</Badge>}
      </PageHeader>

      {!connected ? (
        <Alert className="mb-4">
          <AlertTitle>Connect Webflow to see your existing content</AlertTitle>
          <AlertDescription>Paste a site API token under <Link className="underline-offset-2 hover:underline" href={`/app/sites/${siteId}/connectors` as Route}>Connectors</Link>. Every collection the token can see is inventoried nightly; the first sync runs right after you connect.</AlertDescription>
        </Alert>
      ) : null}
      {connected && (!avail.gsc || !(avail.native || avail.profound)) ? (
        <Alert variant="warning" className="mb-4">
          <AlertTitle>Some signals are missing</AlertTitle>
          <AlertDescription>
            {!avail.gsc ? "Search Console is not connected, so traffic and decline are unknown and count as neutral. " : ""}
            {!avail.native && !avail.profound ? "No AI citation data yet: track prompts under Demand or connect Profound under Strategy. " : ""}
            {avail.profound && !avail.native ? "Citations come from Profound only. " : ""}
            Scores are still computed from what is known; the breakdown says which factor carried each one.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {manager ? <ActionButton size="sm" variant="outline" action={syncInventoryAction.bind(null, siteId)} done="Sync queued" disabled={!connected}>Sync inventory now</ActionButton> : null}
        {editor ? <ActionButton size="sm" variant="outline" action={rescoreRefreshAction.bind(null, siteId)} done="Rescore queued" disabled={!connected}>Rescore</ActionButton> : null}
        <span className="text-muted-foreground text-xs">Scored {when(overview.scoredAt)} · signals: CMS dates{avail.gsc ? " · Search Console 28d" : ""}{avail.native ? " · AI Overview tracking 30d" : ""}{avail.profound ? " · Profound 30d" : ""}</span>
      </div>

      <UrlTabs defaultValue="candidates" values={sections.map((s) => s.value)}>
        <TabsList>
          <TabsTrigger value="candidates">Needs a refresh {candidates.length ? <Badge variant="secondary">{candidates.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="inventory">All CMS content</TabsTrigger>
        </TabsList>

        <TabsContent value="candidates" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Prioritised</CardTitle>
              <CardDescription>Score = staleness 25% · search demand 25% · decline 20% · citation gap 20% · thinness 10%. The nightly scan opens the top {candidates.length > 20 ? 20 : candidates.length || "few"} as refresh opportunities; anything here can be started by hand.</CardDescription>
            </CardHeader>
            <CardContent>
              {candidates.length === 0 ? (
                <p className="text-muted-foreground text-sm">{overview.items === 0 ? "No inventory yet. Sync Webflow to fill this." : overview.scoredAt ? "Nothing over the threshold right now. Everything that is getting traffic is also being cited, or was updated recently." : "Not scored yet; rescore or wait for the nightly scan."}</p>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Score</TableHead><TableHead>Post</TableHead><TableHead>Last modified</TableHead><TableHead className="text-right">Clicks / impr. 28d</TableHead><TableHead className="text-right">AI citations 30d</TableHead><TableHead>Why</TableHead><TableHead></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {candidates.map((i) => {
                      const s = i.refresh_signals;
                      return (
                        <TableRow key={i.id}>
                          <TableCell className="font-mono tabular-nums">{Math.round(i.refresh_score ?? 0)}</TableCell>
                          <TableCell className="max-w-sm">
                            <p className="truncate font-medium">{i.title ?? i.slug ?? i.external_id}</p>
                            <p className="text-muted-foreground truncate text-xs">{i.collection_name}{i.url ? <> · <a className="font-mono underline-offset-2 hover:underline" href={i.url} target="_blank" rel="noreferrer">{new URL(i.url).pathname}</a></> : null} · {i.word_count} words</p>
                          </TableCell>
                          <TableCell><span title={day(i.last_updated)}>{ageLabel(i.last_updated)}</span></TableCell>
                          <TableCell className="text-right tabular-nums">{s?.gsc.available ? <>{n(s.gsc.clicks)} / {n(s.gsc.impressions)}{delta(s.gsc.clicks, s.gsc.clicksPrev) ? <span className="text-muted-foreground ml-1 text-xs">{delta(s.gsc.clicks, s.gsc.clicksPrev)}</span> : null}</> : <span className="text-muted-foreground">no GSC</span>}</TableCell>
                          <TableCell className="text-right tabular-nums">{s ? <>{s.citations.nativeAvailable ? `${s.citations.native}` : "—"}{s.citations.profoundAvailable ? <span className="text-muted-foreground ml-1 text-xs">· Profound {s.citations.profound}</span> : null}</> : "—"}</TableCell>
                          <TableCell className="max-w-xs text-xs">{i.refresh_reasons.length ? i.refresh_reasons.join(" · ") : <span className="text-muted-foreground">no single reason stands out</span>}</TableCell>
                          <TableCell className="text-right">
                            <span className="inline-flex items-center gap-2">
                              <RefreshState i={i} />
                              {editor && !i.pending_approval_id && i.opportunity_status !== "queued" && i.opportunity_status !== "in_progress" ? <ActionButton size="sm" action={refreshItemAction.bind(null, siteId, i.id, undefined)} done="Started">Refresh now</ActionButton> : null}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inventory" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Inventory</CardTitle>
              <CardDescription>{collections.length ? `Collections: ${collections.join(", ")}.` : "Every collection the Webflow token can see."} Items without a rich-text body (categories, authors) are listed but never rewritten. Last modified and last published come from Webflow.</CardDescription>
            </CardHeader>
            <CardContent>
              {items.length === 0 ? <p className="text-muted-foreground text-sm">No inventory yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Collection</TableHead><TableHead>State</TableHead><TableHead>Last modified</TableHead><TableHead>Last published</TableHead><TableHead className="text-right">Clicks / impr. 28d</TableHead><TableHead className="text-right">Citations 30d</TableHead><TableHead className="text-right">Score</TableHead><TableHead></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {items.map((i) => {
                      const s = i.refresh_signals;
                      const excluded = s?.exclusion ?? (!i.has_body ? "no rich-text body" : null);
                      return (
                        <TableRow key={i.id}>
                          <TableCell className="max-w-sm">
                            <p className="truncate font-medium">{i.title ?? i.slug ?? i.external_id}</p>
                            <p className="text-muted-foreground truncate font-mono text-xs">{i.url ? <a className="underline-offset-2 hover:underline" href={i.url} target="_blank" rel="noreferrer">{new URL(i.url).pathname}</a> : i.slug ?? i.external_id}{i.content_item_id ? <span className="ml-2 font-sans">· ours{i.last_refreshed_at ? `, refreshed ${day(i.last_refreshed_at)}` : ""}</span> : null}</p>
                          </TableCell>
                          <TableCell>{i.collection_name}</TableCell>
                          <TableCell><StateBadge i={i} /></TableCell>
                          <TableCell>{day(i.last_updated)}</TableCell>
                          <TableCell>{day(i.last_published)}</TableCell>
                          <TableCell className="text-right tabular-nums">{s?.gsc.available ? `${n(s.gsc.clicks)} / ${n(s.gsc.impressions)}` : "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{s && (s.citations.nativeAvailable || s.citations.profoundAvailable) ? `${s.citations.native + s.citations.profound}` : "—"}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{excluded ? <span className="text-muted-foreground text-xs" title={excluded}>{excluded}</span> : i.refresh_score === null ? "—" : Math.round(i.refresh_score)}</TableCell>
                          <TableCell className="text-right">
                            <span className="inline-flex items-center gap-2">
                              <RefreshState i={i} />
                              {editor && i.has_body && !i.missing && !i.is_archived && !i.pending_approval_id && i.opportunity_status !== "queued" && i.opportunity_status !== "in_progress" ? <ActionButton size="sm" variant="outline" action={refreshItemAction.bind(null, siteId, i.id, undefined)} done="Started">Refresh</ActionButton> : null}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </UrlTabs>
    </AppShell>
  );
}
