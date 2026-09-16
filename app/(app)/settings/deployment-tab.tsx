import { LiveRefresh } from "@/components/app/live-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isAuthConfigured, supabaseServer } from "@/lib/auth/supabase";
import { jwtClaims, runSetupChecks, type CheckGroup, type CheckState } from "@/lib/ops/setup";
import { sendJobsPing } from "@/lib/ops/setup-actions";

const GROUPS: { key: CheckGroup; title: string; blurb: string }[] = [
  { key: "database", title: "Database", blurb: "Supabase connection, migrations, the renderer role's isolation, and the PostgREST schema the middleware reads sites from." },
  { key: "auth", title: "Auth", blurb: "Supabase Auth redirect and the access-token hook that puts org_ids and is_staff into every session." },
  { key: "app", title: "App", blurb: "Deployment identity and who gets the ops console." },
  { key: "edge", title: "Edge", blurb: "The wildcard domain customer rewrites point at. See docs/EDGE_SETUP.md." },
  { key: "jobs", title: "Jobs and models", blurb: "Inngest runs every pipeline; the model key makes them do something. The endpoint check proves Inngest can call this app, the heartbeat proves it does, and the test event proves an event sent from here comes back as a run." },
  { key: "integrations", title: "Integrations", blurb: "Optional until you connect the first workspace or property." },
];

function StateBadge({ state }: { state: CheckState }) {
  if (state === "ok") return <Badge variant="success">ok</Badge>;
  if (state === "fail") return <Badge variant="destructive">missing</Badge>;
  if (state === "warn") return <Badge variant="warning">check</Badge>;
  return <Badge variant="outline">skipped</Badge>;
}

/** Settings → Deployment (staff): live checks against this deployment, each failure naming the variable or dashboard toggle that fixes it. */
export async function DeploymentTab() {
  let claims: Record<string, unknown> | null = null;
  if (isAuthConfigured()) {
    const { data } = await (await supabaseServer()).auth.getSession();
    claims = jwtClaims(data.session?.access_token);
  }
  const report = await runSetupChecks({ claims });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-sm">Live checks against this deployment. Each failure names the dashboard toggle or variable that fixes it.</p>
        {report.failing ? <Badge variant="destructive">{report.failing} failing</Badge> : <Badge variant="success">all required checks pass</Badge>}
        {report.warnings ? <Badge variant="warning">{report.warnings} to confirm</Badge> : null}
      </div>
      <LiveRefresh active={report.checks.some((c) => c.live)} intervalMs={5000} maxMs={3 * 60 * 1000} />
      {GROUPS.map((g) => {
        const rows = report.checks.filter((c) => c.group === g.key);
        if (rows.length === 0) return null;
        return (
          <Card key={g.key}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><CardTitle>{g.title}</CardTitle><CardDescription>{g.blurb}</CardDescription></div>
                {g.key === "jobs" ? (
                  <form action={sendJobsPing}>
                    <Button type="submit" variant="outline" size="sm">Send a test event</Button>
                  </form>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead className="w-56">Check</TableHead><TableHead className="w-24">State</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((c) => (
                    <TableRow key={c.key}>
                      <TableCell className="font-medium">{c.label}</TableCell>
                      <TableCell><StateBadge state={c.state} /></TableCell>
                      <TableCell>
                        <div className="text-sm">{c.detail}</div>
                        {c.fix && c.state !== "ok" ? <div className="text-muted-foreground mt-1 text-xs">{c.fix}</div> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
