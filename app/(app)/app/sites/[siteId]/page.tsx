import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { ActionButton } from "@/components/app/action-button";
import { CopyBlock } from "@/components/app/copy-block";
import { AppShell, PageHeader } from "@/components/app/shell";
import { HealthBadge, SiteStatusBadge, VerdictBadge, when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { decideApprovalAction, dismissOpportunityAction, runHealthCheckAction, runPreflightAction, scanOpportunitiesAction, setSiteStatusAction, startPipelineAction } from "@/lib/app/actions";
import { listConnectionsForOrg, listHealthChecks, listOpportunities, listPendingApprovals, listPreflights, listPublished } from "@/lib/app/queries";
import { loadSite } from "@/lib/app/store";
import { canManage, requireUser, roleIn } from "@/lib/auth/session";
import { buildInstall } from "@/lib/proxy/install";
import { crawlSummary } from "@/lib/analytics/crawl";
import { CrawlersPanel } from "@/components/app/crawlers-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SitePage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const [preflights, health, opportunities, approvals, connections, published, crawl] = await Promise.all([
    listPreflights(siteId),
    listHealthChecks(siteId),
    listOpportunities(siteId),
    listPendingApprovals(siteId),
    listConnectionsForOrg(site.org_id),
    listPublished(siteId),
    crawlSummary(siteId),
  ]);
  const install = buildInstall({
    site: { id: site.id, canonicalDomain: site.canonical_domain, pathPrefix: site.path_prefix, edgeHostname: site.edge_hostname, proxyMode: site.proxy_mode, name: site.name },
    mirrorOrigin: process.env.AEO_MIRROR_ORIGIN,
    crawlEndpoint: process.env.APP_URL ? `${process.env.APP_URL}/api/ingest/crawl` : undefined,
    hmacSecret: site.proxy_hmac_secret,
  });
  const latestPreflight = preflights.find((p) => p.kind === "preflight");
  const latestReport = preflights.find((p) => p.crawler_access)?.crawler_access ?? null;
  const manage = canManage(user, site.org_id);
  const nextStep =
    site.status === "provisioning"
      ? "Install the rewrite from the Install tab, then run the preflight. A passing preflight activates the project."
      : site.status === "verifying"
        ? "The rewrite reaches us but a check is failing. Fix it and re-run the preflight."
        : site.last_health_ok === false
          ? "The monitor is seeing failures. Open Checks for the failing items."
          : null;

  return (
    <AppShell user={user} active="projects">
      <PageHeader title={site.name} description={`${site.canonical_domain}${site.path_prefix} · ${site.proxy_mode.replace("_", " ")}`}>
        <SiteStatusBadge status={site.status} />
        <HealthBadge ok={site.last_health_ok} failures={site.health_failures} />
        <Button asChild size="sm" variant="outline"><Link href={`/app/sites/${siteId}/brain` as Route}>Brand brain</Link></Button>
        <Button asChild size="sm" variant="outline"><Link href={`/app/sites/${siteId}/content` as Route}>Content</Link></Button>
        <Button asChild size="sm" variant="outline"><Link href={`/app/sites/${siteId}/demand` as Route}>Demand</Link></Button>
        <Button asChild size="sm" variant="outline"><Link href={`/app/sites/${siteId}/attribution` as Route}>Attribution</Link></Button>
        {manage && site.status === "active" ? <ActionButton size="sm" variant="outline" action={setSiteStatusAction.bind(null, siteId, "paused")}>Pause</ActionButton> : null}
        {manage && site.status === "paused" ? <ActionButton size="sm" variant="outline" action={setSiteStatusAction.bind(null, siteId, "active")}>Resume</ActionButton> : null}
      </PageHeader>

      {nextStep ? (
        <Alert className="mb-6" variant={site.last_health_ok === false ? "destructive" : "default"}>
          <AlertTriangle />
          <AlertTitle>Next step</AlertTitle>
          <AlertDescription>{nextStep}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue={site.status === "active" ? "content" : "install"}>
        <TabsList>
          <TabsTrigger value="install">Install</TabsTrigger>
          <TabsTrigger value="checks">Checks</TabsTrigger>
          <TabsTrigger value="content">Content {opportunities.length + approvals.length ? <Badge variant="secondary">{opportunities.length + approvals.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="crawlers">Crawlers {crawl.byPurpose.some((p) => p.purpose === "live_fetch" && p.hits24h > 0) ? <Badge variant="success">live</Badge> : null}</TabsTrigger>
          <TabsTrigger value="connectors">Connectors</TabsTrigger>
        </TabsList>

        <TabsContent value="install" className="grid gap-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>1. Add one rewrite on {site.canonical_domain}</CardTitle>
              <CardDescription>
                Route <span className="font-mono">{`${site.path_prefix}/*`}</span> to <span className="font-mono">{site.edge_hostname}</span>. The rest of your site is untouched. Never proxy your root robots.txt.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {install.warnings.length ? (
                <Alert variant="warning">
                  <AlertTitle>What this mode gives up</AlertTitle>
                  <AlertDescription><ul className="list-disc pl-4">{install.warnings.map((w) => <li key={w}>{w}</li>)}</ul></AlertDescription>
                </Alert>
              ) : null}
              <CopyBlock filename={install.filename} text={install.config} />
              {install.routePattern ? <p className="text-muted-foreground text-xs">Route pattern: <span className="font-mono">{install.routePattern}</span></p> : null}
              <div className="text-sm">
                <p className="font-medium">Also rewrite these root paths to us (we merge with anything you already serve):</p>
                <ul className="text-muted-foreground mt-1 list-disc pl-4 font-mono text-xs">{install.extraRewrites.map((r) => <li key={r.source}>{r.source} <span className="font-sans">— {r.reason}</span></li>)}</ul>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>2. Add one line to your robots.txt</CardTitle>
              <CardDescription>So Google reads the sitemap we generate for your articles. The health check verifies it.</CardDescription>
            </CardHeader>
            <CardContent><CopyBlock filename="robots.txt (append)" text={`Sitemap: https://${site.canonical_domain}${site.path_prefix}/sitemap.xml`} /></CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>3. Verify</CardTitle>
              <CardDescription>The preflight checks for path collisions, that the rewrite reaches us with cookies stripped, your CSP, and what your edge does to each AI crawler.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <ActionButton action={runPreflightAction.bind(null, siteId, "preflight")} done="Preflight queued — refresh in a minute">Run preflight</ActionButton>
              <ActionButton variant="outline" action={runPreflightAction.bind(null, siteId, "crawler_report")} done="Report queued">AI Crawler Access Report</ActionButton>
              <ActionButton variant="outline" action={runHealthCheckAction.bind(null, siteId, site.status === "active" ? "monitor" : "verification")} done="Check queued">Health check now</ActionButton>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="checks" className="grid gap-4 pt-4">
          {latestPreflight ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {latestPreflight.ok ? <CheckCircle2 className="text-success size-5" /> : latestPreflight.status === "completed" ? <XCircle className="text-destructive size-5" /> : null}
                  Latest preflight · {latestPreflight.status}
                </CardTitle>
                <CardDescription>{when(latestPreflight.completed_at ?? latestPreflight.created_at)}</CardDescription>
              </CardHeader>
              <CardContent>
                {latestPreflight.blocking.length ? <ul className="list-disc pl-4 text-sm">{latestPreflight.blocking.map((b) => <li key={b}>{b}</li>)}</ul> : latestPreflight.status === "completed" ? <p className="text-sm">Nothing blocking. The project is active.</p> : latestPreflight.error ? <p className="text-destructive text-sm">{latestPreflight.error}</p> : <p className="text-muted-foreground text-sm">Running…</p>}
              </CardContent>
            </Card>
          ) : (
            <p className="text-muted-foreground text-sm">No preflight yet. Run one from the Install tab.</p>
          )}
          {latestReport ? (
            <Card>
              <CardHeader>
                <CardTitle>AI Crawler Access Report · score {latestReport.summary.score}/100</CardTitle>
                <CardDescription>Probed {latestReport.url} at {when(latestReport.probedAt)}. Allowed {latestReport.summary.allowed}, blocked {latestReport.summary.blocked}, challenged {latestReport.summary.challenged}.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Crawler</TableHead><TableHead>Tier</TableHead><TableHead>Purpose</TableHead><TableHead>Edge</TableHead><TableHead>robots.txt</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {latestReport.results.map((r) => (
                      <TableRow key={r.name}>
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell>{r.tier}</TableCell>
                        <TableCell>{r.purpose}</TableCell>
                        <TableCell><VerdictBadge verdict={r.verdict} /></TableCell>
                        <TableCell>{r.robots === "disallowed" ? <Badge variant="destructive">disallowed</Badge> : r.robots}</TableCell>
                        <TableCell className="text-muted-foreground max-w-xs truncate text-xs">{r.reason}{r.robotsRule ? ` · ${r.robotsRule}` : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Health checks</CardTitle><CardDescription>Every five minutes once active. Alerts fire on the second consecutive failure and on recovery.</CardDescription></CardHeader>
            <CardContent>
              {health.length === 0 ? <p className="text-muted-foreground text-sm">No checks yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Kind</TableHead><TableHead>Result</TableHead><TableHead>TTFB</TableHead><TableHead>Failed checks</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {health.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell>{when(h.checked_at)}</TableCell>
                        <TableCell>{h.kind}</TableCell>
                        <TableCell>{h.ok ? <Badge variant="success">ok</Badge> : <Badge variant="destructive">failed</Badge>}</TableCell>
                        <TableCell>{h.ttfb_ms != null ? `${h.ttfb_ms} ms` : "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{h.failed.join(", ") || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="content" className="grid gap-4 pt-4">
          {approvals.length ? (
            <Card>
              <CardHeader><CardTitle>Waiting for your approval</CardTitle><CardDescription>Approving a brief is the highest-leverage 90 seconds in the pipeline.</CardDescription></CardHeader>
              <CardContent className="grid gap-3">
                {approvals.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="font-medium"><Badge variant="secondary" className="mr-2">{a.kind}</Badge>{a.title ?? "(untitled)"}</p>
                      {a.summary ? <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">{a.summary}</p> : null}
                    </div>
                    <div className="flex gap-2">
                      <Button asChild size="sm" variant="outline"><Link href={`/app/approvals/${a.id}` as Route}>Review</Link></Button>
                      <ActionButton size="sm" action={decideApprovalAction.bind(null, a.id, "approve", undefined)} done="Approved">Approve</ActionButton>
                      <ActionButton size="sm" variant="outline" action={decideApprovalAction.bind(null, a.id, "regenerate", undefined)} done="Regenerating">Regenerate</ActionButton>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Opportunity queue</CardTitle>
              <CardDescription>Citation gaps, buyer questions and signals, scored so the number is arguable. Start one to run it through brief → draft → QA → approval → publish.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div><ActionButton size="sm" variant="outline" action={scanOpportunitiesAction.bind(null, siteId)} done="Scan queued">Rescan now</ActionButton></div>
              {opportunities.length === 0 ? <p className="text-muted-foreground text-sm">Nothing queued. Connect Search Console or mine a question graph to fill this.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Score</TableHead><TableHead>Opportunity</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow></TableHeader>
                  <TableBody>
                    {opportunities.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-mono">{o.score.toFixed(0)}</TableCell>
                        <TableCell className="max-w-md"><p className="truncate font-medium">{o.title}</p><p className="text-muted-foreground truncate text-xs">{o.target_query}</p></TableCell>
                        <TableCell><Badge variant="outline">{o.source}</Badge></TableCell>
                        <TableCell>{o.status}</TableCell>
                        <TableCell className="text-right">
                          {o.status === "open" ? (
                            <span className="inline-flex gap-2">
                              <ActionButton size="sm" action={startPipelineAction.bind(null, o.id, undefined)} done="Started">Draft it</ActionButton>
                              <ActionButton size="sm" variant="ghost" action={dismissOpportunityAction.bind(null, o.id)} done="Dismissed">Dismiss</ActionButton>
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
          <Card>
            <CardHeader><CardTitle>Published</CardTitle></CardHeader>
            <CardContent>
              {published.length === 0 ? <p className="text-muted-foreground text-sm">Nothing published yet.</p> : (
                <ul className="grid gap-1 text-sm">{published.map((p) => <li key={p.path} className="flex justify-between gap-4"><a className="truncate underline-offset-2 hover:underline" href={`https://${site.canonical_domain}${p.path}`} target="_blank" rel="noreferrer">{p.title ?? p.path}</a><span className="text-muted-foreground shrink-0 text-xs">{when(p.updated_at)}</span></li>)}</ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="crawlers" className="grid gap-4 pt-4">
          <CrawlersPanel crawl={crawl} proxyMode={site.proxy_mode} />
        </TabsContent>

        <TabsContent value="connectors" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Connectors for {site.name}&apos;s organisation</CardTitle><CardDescription>Slack feeds the brand brain and receives approvals; Google Search Console and GA4 give real demand and AI-referral traffic; Profound is enrichment.</CardDescription></CardHeader>
            <CardContent className="grid gap-3">
              {connections.length === 0 ? <p className="text-muted-foreground text-sm">Nothing connected.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead>Last sync</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {connections.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.provider}</TableCell>
                        <TableCell>{c.external_account_name ?? c.external_account_id ?? "—"}</TableCell>
                        <TableCell><Badge variant={c.status === "active" ? "success" : c.status === "error" ? "destructive" : "secondary"}>{c.status}</Badge>{c.last_error ? <span className="text-destructive ml-2 text-xs">{c.last_error.slice(0, 80)}</span> : null}</TableCell>
                        <TableCell>{when(c.last_synced_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent" href={`/api/connectors/slack/start?orgId=${site.org_id}&returnTo=/app/sites/${siteId}`}>Connect Slack</a>
                <a className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent" href={`/api/connectors/google/start?orgId=${site.org_id}&siteId=${siteId}&returnTo=/app/sites/${siteId}`}>Connect Google (GSC + GA4)</a>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
