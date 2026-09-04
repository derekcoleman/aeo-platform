import type { Route } from "next";
import Link from "next/link";
import { AppShell, PageHeader } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireStaff } from "@/lib/auth/session";
import { isAuthConfigured, supabaseServer } from "@/lib/auth/supabase";
import { jwtClaims, runSetupChecks, type CheckGroup, type CheckState } from "@/lib/ops/setup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GROUPS: { key: CheckGroup; title: string; blurb: string }[] = [
  { key: "database", title: "Database", blurb: "Supabase connection, migrations, the renderer role's isolation, and the PostgREST schema the middleware reads sites from." },
  { key: "auth", title: "Auth", blurb: "Supabase Auth redirect and the access-token hook that puts org_ids and is_staff into every session." },
  { key: "app", title: "App", blurb: "Deployment identity and who gets the ops console." },
  { key: "edge", title: "Edge", blurb: "The wildcard domain customer rewrites point at. See docs/EDGE_SETUP.md." },
  { key: "jobs", title: "Jobs and models", blurb: "Inngest runs every pipeline; the model key makes them do something." },
  { key: "integrations", title: "Integrations", blurb: "Optional until you connect the first workspace or property." },
];

function StateBadge({ state }: { state: CheckState }) {
  if (state === "ok") return <Badge variant="success">ok</Badge>;
  if (state === "fail") return <Badge variant="destructive">missing</Badge>;
  if (state === "warn") return <Badge variant="warning">check</Badge>;
  return <Badge variant="outline">skipped</Badge>;
}

export default async function SetupPage() {
  const user = await requireStaff();
  let claims: Record<string, unknown> | null = null;
  if (isAuthConfigured()) {
    const { data } = await (await supabaseServer()).auth.getSession();
    claims = jwtClaims(data.session?.access_token);
  }
  const report = await runSetupChecks({ claims });
  return (
    <AppShell user={user} active="ops">
      <PageHeader title="Setup checklist" description="Live checks against this deployment. Each failure names the dashboard toggle or variable that fixes it.">
        {report.failing ? <Badge variant="destructive">{report.failing} failing</Badge> : <Badge variant="success">all required checks pass</Badge>}
        {report.warnings ? <Badge variant="warning">{report.warnings} to confirm</Badge> : null}
        <Button asChild variant="outline" size="sm"><Link href={"/ops" as Route}>Back to ops</Link></Button>
      </PageHeader>
      <div className="grid gap-4">
        {GROUPS.map((g) => {
          const rows = report.checks.filter((c) => c.group === g.key);
          if (rows.length === 0) return null;
          return (
            <Card key={g.key}>
              <CardHeader><CardTitle>{g.title}</CardTitle><CardDescription>{g.blurb}</CardDescription></CardHeader>
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
    </AppShell>
  );
}
