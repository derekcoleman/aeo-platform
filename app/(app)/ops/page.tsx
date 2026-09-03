import Link from "next/link";
import type { Route } from "next";
import { ActionButton } from "@/components/app/action-button";
import { AppShell, PageHeader } from "@/components/app/shell";
import { HealthBadge, SiteStatusBadge, when } from "@/components/app/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { runHealthCheckAction, runPreflightAction, scanOpportunitiesAction, setFeatureAction, setSiteStatusAction } from "@/lib/app/actions";
import { opsFailedSyncs, opsLlmSpend, opsOrganizations, opsSites, opsStaff } from "@/lib/app/queries";
import { requireStaff } from "@/lib/auth/session";
import { StaffForm } from "./staff-form";

export const dynamic = "force-dynamic";

/** Staff-only. Every action here is audited; nothing runs as a raw service client from the browser. */
export default async function OpsPage() {
  const user = await requireStaff();
  const [orgs, sites, failed, spend, staff] = await Promise.all([opsOrganizations(), opsSites(), opsFailedSyncs(), opsLlmSpend(), opsStaff()]);
  const failingSites = sites.filter((s) => s.last_health_ok === false).length;
  return (
    <AppShell user={user} active="ops">
      <PageHeader title="Ops console" description="Every tenant, every site, and what each one is costing us.">
        <Badge variant="secondary">{orgs.length} orgs</Badge>
        <Badge variant="secondary">{sites.length} sites</Badge>
        {failingSites ? <Badge variant="destructive">{failingSites} failing</Badge> : <Badge variant="success">all healthy</Badge>}
        {failed.length ? <Badge variant="warning">{failed.length} failed syncs / 7d</Badge> : null}
      </PageHeader>
      <Tabs defaultValue="sites">
        <TabsList>
          <TabsTrigger value="sites">Sites</TabsTrigger>
          <TabsTrigger value="orgs">Organisations</TabsTrigger>
          <TabsTrigger value="health">Connector health</TabsTrigger>
          <TabsTrigger value="spend">LLM spend</TabsTrigger>
          <TabsTrigger value="staff">Staff</TabsTrigger>
        </TabsList>

        <TabsContent value="sites" className="pt-4">
          <Card>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Site</TableHead><TableHead>Org</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead>Health</TableHead><TableHead>Published</TableHead><TableHead>Open opps</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {sites.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell><Link className="font-medium underline-offset-2 hover:underline" href={`/app/sites/${s.id}` as Route}>{s.name}</Link><p className="text-muted-foreground font-mono text-xs">{s.canonical_domain}{s.path_prefix}</p></TableCell>
                      <TableCell>{s.org_name}</TableCell>
                      <TableCell className="text-xs">{s.proxy_mode}</TableCell>
                      <TableCell><SiteStatusBadge status={s.status} /></TableCell>
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
                <TableHeader><TableRow><TableHead>Organisation</TableHead><TableHead>Plan</TableHead><TableHead>Members</TableHead><TableHead>Sites</TableHead><TableHead>Profound</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
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
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Org</TableHead><TableHead>Provider</TableHead><TableHead>Kind</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
                  <TableBody>{failed.map((f) => <TableRow key={f.id}><TableCell>{when(f.started_at)}</TableCell><TableCell>{f.org_name}</TableCell><TableCell>{f.provider}</TableCell><TableCell>{f.kind}</TableCell><TableCell className="max-w-md truncate text-xs">{f.error}</TableCell></TableRow>)}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="spend" className="pt-4">
          <Card>
            <CardHeader><CardTitle>Model spend by organisation, last 30 days</CardTitle><CardDescription>From ops.llm_calls. Billing truth is the provider invoice; this is the per-tenant view.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Org</TableHead><TableHead>Calls</TableHead><TableHead>Estimated USD</TableHead></TableRow></TableHeader>
                <TableBody>{spend.map((s) => <TableRow key={s.org_name}><TableCell>{s.org_name}</TableCell><TableCell>{s.calls}</TableCell><TableCell className="font-mono">${s.cost_usd.toFixed(2)}</TableCell></TableRow>)}</TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="staff" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Internal staff</CardTitle><CardDescription>A separate axis from customer memberships. Staff read every org and use this console.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <Table>
                <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Level</TableHead></TableRow></TableHeader>
                <TableBody>
                  {staff.staff.map((s) => <TableRow key={s.user_id}><TableCell>{s.email}</TableCell><TableCell>{s.name ?? "—"}</TableCell><TableCell>{s.level}</TableCell></TableRow>)}
                  {staff.bootstrap.filter((b) => !staff.staff.some((s) => s.email.toLowerCase() === b.email)).map((b) => <TableRow key={b.email}><TableCell>{b.email}</TableCell><TableCell className="text-muted-foreground">not signed in yet</TableCell><TableCell>{b.level}</TableCell></TableRow>)}
                </TableBody>
              </Table>
              <StaffForm />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
