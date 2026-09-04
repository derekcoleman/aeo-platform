import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listContentItems } from "@/lib/app/content";
import { loadSite } from "@/lib/app/store";
import { requireUser, roleIn } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline" | "destructive"> = {
  published: "success",
  draft: "secondary",
  in_review: "warning",
  archived: "outline",
  failed: "destructive",
};

export default async function ContentPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}/content`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const items = await listContentItems(siteId);
  return (
    <AppShell user={user} active="projects">
      <PageHeader title={`${site.name} · Content`} description="Every piece the pipeline has produced, its latest version, QA state and where it is published.">
        <Badge variant="secondary">{items.length} items</Badge>
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${siteId}` as Route}>Back to project</Link></Button>
      </PageHeader>
      <Card>
        <CardHeader><CardTitle>Items</CardTitle><CardDescription>Open a version to preview it in your theme with every fact and source it cites. Gates waiting on you show an approval link.</CardDescription></CardHeader>
        <CardContent>
          {items.length === 0 ? <p className="text-muted-foreground text-sm">Nothing yet. Start an opportunity from the Content tab on the project page.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Status</TableHead><TableHead>Version</TableHead><TableHead>QA</TableHead><TableHead>Published</TableHead><TableHead>Updated</TableHead><TableHead></TableHead></TableRow></TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="max-w-md"><p className="truncate font-medium">{i.title ?? i.slug}</p><p className="text-muted-foreground font-mono text-xs">{i.slug}</p></TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[i.status] ?? "secondary"}>{i.status}</Badge></TableCell>
                    <TableCell>{i.version_no ? `v${i.version_no} · ${i.word_count ?? 0} words` : "—"}</TableCell>
                    <TableCell>{i.current_version_id ? (i.qa_failed ? <Badge variant="destructive">{i.qa_failed} failing</Badge> : <Badge variant="success">passed</Badge>) : "—"}</TableCell>
                    <TableCell>{i.published_path ? <a className="underline-offset-2 hover:underline" href={`https://${site.canonical_domain}${i.published_path}`} target="_blank" rel="noreferrer">{i.published_path}</a> : <span className="text-muted-foreground">not yet</span>}</TableCell>
                    <TableCell>{when(i.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex gap-2">
                        {i.pending_approval_id ? <Button asChild size="sm"><Link href={`/app/approvals/${i.pending_approval_id}` as Route}>Review {i.pending_kind}</Link></Button> : null}
                        {i.current_version_id ? <Button asChild size="sm" variant="outline"><a href={`/app/preview/${i.current_version_id}`} target="_blank" rel="noreferrer">Preview</a></Button> : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
