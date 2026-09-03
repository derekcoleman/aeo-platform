import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listConnectionsForOrg } from "@/lib/app/queries";
import { listOrganizations } from "@/lib/app/store";
import { requireUser, visibleOrgIds } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Where the OAuth callbacks land by default. One table per organisation. */
export default async function ConnectorsPage({ searchParams }: { searchParams: Promise<{ connector?: string; error?: string; connected?: string }> }) {
  const user = await requireUser("/settings/connectors");
  const { connector, error, connected } = await searchParams;
  const orgs = await listOrganizations(visibleOrgIds(user));
  const byOrg = await Promise.all(orgs.map(async (o) => ({ org: o, connections: await listConnectionsForOrg(o.id) })));
  return (
    <AppShell user={user} active="connectors">
      <PageHeader title="Connectors" description="Tokens live in Vault; these rows hold only a reference. Every sync writes a run row, so a failing connector is visible here, never silent." />
      {error ? <Alert variant="destructive" className="mb-6"><AlertTitle>{connector ?? "Connector"} did not connect</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {connected ? <Alert variant="success" className="mb-6"><AlertTitle>{connected} connected</AlertTitle><AlertDescription>The first backfill is queued.</AlertDescription></Alert> : null}
      {byOrg.map(({ org, connections }) => (
        <Card key={org.id} className="mb-6">
          <CardHeader><CardTitle>{org.name}</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            {connections.length === 0 ? <p className="text-muted-foreground text-sm">Nothing connected. Connect from a project page.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Account</TableHead><TableHead>Scope</TableHead><TableHead>Status</TableHead><TableHead>Last sync</TableHead></TableRow></TableHeader>
                <TableBody>
                  {connections.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.provider}</TableCell>
                      <TableCell>{c.external_account_name ?? c.external_account_id ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{c.scope.length ? `${c.scope.length} selected` : "none selected"}</TableCell>
                      <TableCell><Badge variant={c.status === "active" ? "success" : c.status === "error" ? "destructive" : "secondary"}>{c.status}</Badge></TableCell>
                      <TableCell>{when(c.last_synced_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ))}
    </AppShell>
  );
}
