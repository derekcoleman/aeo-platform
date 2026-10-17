import Link from "next/link";
import type { Route } from "next";
import { ActionButton } from "@/components/app/action-button";
import { BudgetCapForm } from "@/components/app/budget-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { HealthBadge, SiteStatusBadge, when } from "@/components/app/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/app/url-tabs";
import { OPS_SECTIONS, opsHref, resolveTab, settingsHref } from "@/lib/app/nav";
import { remediateFaqAction, restateMetricsAction, runHealthCheckAction, runPreflightAction, scanOpportunitiesAction, setFeatureAction, setSiteStatusAction } from "@/lib/app/actions";
import { setAutonomyControlAction } from "@/lib/app/takedown-actions";
import { controlFor, listAutonomyControls, type AutonomyControl, type ControlTarget } from "@/lib/ops/controls";
import { budgetCapMaxUsd, listBudgets, RESOURCE_LABEL, type BudgetRow } from "@/lib/ops/spend";
import { opsFailedSyncs, opsLlmSpend, opsLlmSpendForSite, opsOrganizations, opsSites, type SiteSpendRow } from "@/lib/app/queries";
import { METHODOLOGY_VERSION } from "@/lib/app/methodology";
import { auditLog } from "@/lib/app/org";
import { loadSite } from "@/lib/app/store";
import { requireStaff } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Staff-only. Every action here is audited; nothing runs as a raw service
 * client from the browser. With `?site=` the console is scoped to one
 * project: its row, its organisation, the syncs of its connections, its
 * model spend by task, and the audit entries about it. Staff, the deployment
 * checklist and themes are settings (Settings → Staff / Deployment / Theme).
 */
export default async function OpsPage({ searchParams }: { searchParams: Promise<{ tab?: string; site?: string }> }) {
  const { tab: requestedTab, site: siteParam } = await searchParams;
  const user = await requireStaff();
  const site = siteParam ? await loadSite(siteParam) : null;
  const scope = site ? { siteId: site.id, orgId: site.org_id } : {};
  const sections = OPS_SECTIONS;
  const tab = resolveTab(sections, requestedTab, "sites");
  const [orgs, sites, failed, spend, siteSpend, audit, controls, budgets] = await Promise.all([
    opsOrganizations(scope),
    opsSites(scope),
    opsFailedSyncs(7, scope),
    site ? Promise.resolve([]) : opsLlmSpend(),
    site ? opsLlmSpendForSite(site.id) : Promise.resolve([] as SiteSpendRow[]),
    auditLog(site?.org_id ?? null, 200, undefined, site?.id ?? null),
    listAutonomyControls(),
    listBudgets({ orgId: site?.org_id ?? null }),
  ]);
  const platform = controlFor(controls, { scope: "global", id: null });
  const failingSites = sites.filter((s) => s.last_health_ok === false).length;
  return (
    <AppShell user={user} active="ops" site={site} page="console" section={tab}>
      <PageHeader title={site ? `Ops · ${site.name}` : "Ops console"} eyebrow={site ? "Project view" : undefined} description={site ? `Only what belongs to ${site.canonical_domain}: its site row, its organisation, the syncs of its connections, its model spend and its audit trail.` : "Every tenant, every site, and what each one is costing us."}>
        {site ? <Link className="text-sm underline-offset-2 hover:underline" href={opsHref(null) as Route}>Show all projects</Link> : <Badge variant="secondary">{orgs.length} orgs</Badge>}
        {site ? null : <Badge variant="secondary">{sites.length} sites</Badge>}
        {failingSites ? <Badge variant="destructive">{site ? "proxy failing" : `${failingSites} failing`}</Badge> : <Badge variant="success">{site ? "proxy healthy" : "all healthy"}</Badge>}
        {failed.length ? <Badge variant="warning">{failed.length} failed syncs / 7d</Badge> : null}
        <ActionButton size="sm" variant="outline" action={remediateFaqAction.bind(null, site?.id ?? null)} done="queued" title="Republish pages whose FAQ section was printed twice and push their Webflow copies again. No model call; the audit log lists the paths.">
          Fix duplicate FAQs
        </ActionButton>
        <ActionButton size="sm" variant="outline" action={restateMetricsAction.bind(null, site?.id ?? null)} done="queued" title={`Recompute the headline numbers the old way and the ${METHODOLOGY_VERSION} way, so Strategy, Demand and Attribution can show what moved and why. No vendor calls.`}>
          Restate metrics
        </ActionButton>
      </PageHeader>
      <UrlTabs defaultValue="sites" values={sections.map((s) => s.value)}>
        <TabsList>
          <TabsTrigger value="sites">{site ? "Site" : "Sites"}</TabsTrigger>
          <TabsTrigger value="orgs">{site ? "Organisation" : "Organisations"}</TabsTrigger>
          <TabsTrigger value="health">Connector health</TabsTrigger>
          <TabsTrigger value="spend">Spend</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="sites" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle>Kill switches</CardTitle>
              <CardDescription>Publishing holds every publish step (runs wait an hour and ask again, for up to three days). Indexing serves every page noindex and empties the sitemap, feed and llms files on the next request. Per organisation and per project below; owners can also pause their own project&apos;s indexing.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Whole platform</span>
              <ControlButtons target={{ scope: "global", id: null }} control={platform} />
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Site</TableHead><TableHead>Org</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead>Health</TableHead><TableHead>Published</TableHead><TableHead>Open opps</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {sites.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell><Link className="font-medium underline-offset-2 hover:underline" href={`/app/sites/${s.id}` as Route}>{s.name}</Link><p className="text-muted-foreground font-mono text-xs">{s.canonical_domain}{s.path_prefix} · <Link className="underline-offset-2 hover:underline" href={settingsHref(s.id, null, "theme") as Route}>theme</Link></p></TableCell>
                      <TableCell>{s.org_name}</TableCell>
                      <TableCell className="text-xs">{s.proxy_mode}</TableCell>
                      <TableCell><SiteStatusBadge status={s.status} />{s.indexing_paused ? <p><Badge variant="warning" title="Paused by the project's owner or an admin">indexing paused</Badge></p> : null}</TableCell>
                      <TableCell><HealthBadge ok={s.last_health_ok} failures={s.health_failures} /><p className="text-muted-foreground text-xs">{when(s.last_health_at)}</p></TableCell>
                      <TableCell>{s.published}</TableCell>
                      <TableCell>{s.open_opportunities}</TableCell>
                      <TableCell className="whitespace-normal">
                        <span className="inline-flex flex-wrap gap-1">
                          <ActionButton size="sm" variant="outline" action={runHealthCheckAction.bind(null, s.id, s.status === "active" ? "monitor" : "verification")} done="queued">Check</ActionButton>
                          <ActionButton size="sm" variant="outline" action={runPreflightAction.bind(null, s.id, "preflight")} done="queued">Preflight</ActionButton>
                          <ActionButton size="sm" variant="outline" action={scanOpportunitiesAction.bind(null, s.id)} done="queued">Scan</ActionButton>
                          {s.status === "active" ? <ActionButton size="sm" variant="ghost" action={setSiteStatusAction.bind(null, s.id, "paused")} done="paused">Pause</ActionButton> : null}
                          {s.status === "paused" ? <ActionButton size="sm" variant="ghost" action={setSiteStatusAction.bind(null, s.id, "active")} done="active">Resume</ActionButton> : null}
                          <ControlButtons target={{ scope: "site", id: s.id }} control={controlFor(controls, { scope: "site", id: s.id })} />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orgs" className="pt-4">
          <Card>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Organisation</TableHead><TableHead>Plan</TableHead><TableHead>Members</TableHead><TableHead>Sites</TableHead><TableHead>Profound</TableHead><TableHead>Kill switches</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                <TableBody>
                  {orgs.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.name} <span className="text-muted-foreground font-mono text-xs">{o.slug}</span></TableCell>
                      <TableCell>{o.plan}</TableCell>
                      <TableCell>{o.members}</TableCell>
                      <TableCell>{o.sites}</TableCell>
                      <TableCell>
                        <ActionButton size="sm" variant={o.profound ? "secondary" : "outline"} action={setFeatureAction.bind(null, o.id, "connector:profound", !o.profound)} done={o.profound ? "disabled" : "enabled"}>
                          {o.profound ? "Enabled — disable" : "Enable"}
                        </ActionButton>
                      </TableCell>
                      <TableCell className="whitespace-normal"><span className="inline-flex flex-wrap gap-1"><ControlButtons target={{ scope: "org", id: o.id }} control={controlFor(controls, { scope: "org", id: o.id })} /></span></TableCell>
                      <TableCell>{when(o.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="health" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Failed syncs, last 7 days</CardTitle><CardDescription>A connector failing silently for two weeks is a churn event. These are the rows that stop that.</CardDescription></CardHeader>
            <CardContent>
              {failed.length === 0 ? <p className="text-muted-foreground text-sm">No failed syncs.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>{site ? "Scope" : "Org"}</TableHead><TableHead>Provider</TableHead><TableHead>Kind</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
                  <TableBody>{failed.map((f) => <TableRow key={f.id}><TableCell>{when(f.started_at)}</TableCell><TableCell>{site ? (f.site_name ?? "organisation-wide") : f.org_name}</TableCell><TableCell>{f.provider}</TableCell><TableCell>{f.kind}</TableCell><TableCell className="max-w-md truncate text-xs">{f.error}</TableCell></TableRow>)}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="spend" className="space-y-4 pt-4">
          <Card>
            <CardHeader><CardTitle>{site ? "Budgets of this project's organisation" : "Budgets"}</CardTitle><CardDescription>What the spend governor enforces (ops.budgets). Every model call, SERP call and answer probe holds its estimated cost on each budget covering it before it runs; none starts once spent reaches the cap. An organisation&apos;s monthly budgets appear the first time it spends. The org-wide SERP cap is the organisation&apos;s own setting, so editing it here edits that. Periods are UTC.</CardDescription></CardHeader>
            <CardContent>
              {budgets.length === 0 ? <p className="text-muted-foreground text-sm">No budgets yet: nothing has been spent through the governor.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Org</TableHead><TableHead>Scope</TableHead><TableHead>Resource</TableHead><TableHead>Period</TableHead><TableHead>Cap</TableHead><TableHead>Spent</TableHead><TableHead>Held</TableHead><TableHead>Used</TableHead></TableRow></TableHeader>
                  <TableBody>{budgets.map((b) => <BudgetTableRow key={b.id} budget={b} />)}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{site ? "Model spend by pipeline task, last 30 days" : "Model spend by organisation, last 30 days"}</CardTitle><CardDescription>From ops.llm_calls. Billing truth is the provider invoice; this is the {site ? "per-project" : "per-tenant"} view.</CardDescription></CardHeader>
            <CardContent>
              {site ? (
                siteSpend.length === 0 ? <p className="text-muted-foreground text-sm">No model calls for this project in the last 30 days.</p> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Calls</TableHead><TableHead>Estimated USD</TableHead></TableRow></TableHeader>
                    <TableBody>{siteSpend.map((s) => <TableRow key={s.task_key}><TableCell className="font-mono text-xs">{s.task_key}</TableCell><TableCell>{s.calls}</TableCell><TableCell className="font-mono">${s.cost_usd.toFixed(2)}</TableCell></TableRow>)}</TableBody>
                  </Table>
                )
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Org</TableHead><TableHead>Calls</TableHead><TableHead>Estimated USD</TableHead></TableRow></TableHeader>
                  <TableBody>{spend.map((s) => <TableRow key={s.org_name}><TableCell>{s.org_name}</TableCell><TableCell>{s.calls}</TableCell><TableCell className="font-mono">${s.cost_usd.toFixed(2)}</TableCell></TableRow>)}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Audit log</CardTitle><CardDescription>{site ? "Staff and owner actions about this project, newest first." : "Every staff and owner action on any organisation, newest first. Billing webhooks land here too."}</CardDescription></CardHeader>
            <CardContent>
              {audit.length === 0 ? <p className="text-muted-foreground text-sm">Nothing recorded yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Org</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Target</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {audit.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="whitespace-nowrap">{when(a.at)}</TableCell>
                        <TableCell>{a.org_name ?? "—"}</TableCell>
                        <TableCell className="text-xs">{a.actor_email ?? "system"}</TableCell>
                        <TableCell className="font-mono text-xs">{a.action}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{a.target_type}{a.target_id ? ` ${a.target_id.slice(0, 8)}` : ""}</TableCell>
                        <TableCell className="text-muted-foreground max-w-xs truncate text-xs">{a.after ? JSON.stringify(a.after).slice(0, 120) : ""}</TableCell>
                      </TableRow>
                    ))}
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

/** Pause or resume publishing and indexing for one scope; a switch that is on shows as a warning. */
function ControlButtons({ target, control }: { target: ControlTarget; control: AutonomyControl | null }) {
  const publishing = control?.publishing_paused ?? false;
  const indexing = control?.indexing_paused ?? false;
  return (
    <>
      <ActionButton size="sm" variant={publishing ? "destructive" : "ghost"} action={setAutonomyControlAction.bind(null, target.scope, target.id, "publishing", !publishing)} done={publishing ? "resumed" : "held"} title={publishing ? "Publishing is held here. Click to resume." : "Hold every publish step here."}>
        {publishing ? "Resume publishing" : "Hold publishing"}
      </ActionButton>
      <ActionButton size="sm" variant={indexing ? "destructive" : "ghost"} action={setAutonomyControlAction.bind(null, target.scope, target.id, "indexing", !indexing)} done={indexing ? "resumed" : "paused"} title={indexing ? "Pages here serve noindex. Click to resume indexing." : "Serve every page here noindex and empty the listings."}>
        {indexing ? "Resume indexing" : "Pause indexing"}
      </ActionButton>
    </>
  );
}

/** One budget: this period's spend and holds against its cap, the cap editable in place. */
function BudgetTableRow({ budget: b }: { budget: BudgetRow }) {
  const used = b.cap_usd > 0 ? Math.round((b.spent_usd / b.cap_usd) * 100) : null;
  return (
    <TableRow>
      <TableCell>{b.org_name}</TableCell>
      <TableCell className="text-xs">{b.site_name ?? "Organisation"}</TableCell>
      <TableCell>{RESOURCE_LABEL[b.resource]}</TableCell>
      <TableCell className="text-xs">{b.period === "day" ? `day ${b.period_start}` : `month from ${b.period_start}`}</TableCell>
      <TableCell><BudgetCapForm budgetId={b.id} capUsd={b.cap_usd} maxUsd={budgetCapMaxUsd(b)} /></TableCell>
      <TableCell className="font-mono">${b.spent_usd.toFixed(2)}</TableCell>
      <TableCell className="font-mono">{b.reserved_usd > 0 ? `$${b.reserved_usd.toFixed(2)}` : "—"}</TableCell>
      <TableCell>
        {used === null ? <Badge variant="destructive">cap $0</Badge> : <Badge variant={used >= 100 ? "destructive" : used >= 80 ? "warning" : "outline"}>{used}%</Badge>}
        {b.alerted_pct ? <p className="text-muted-foreground text-xs">told at {b.alerted_pct}%</p> : null}
      </TableCell>
    </TableRow>
  );
}
