import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listContentItems } from "@/lib/app/content";
import { rollbackPageAction, setIndexingPausedAction, setPageStatusAction } from "@/lib/app/takedown-actions";
import { publishGuard } from "@/lib/pipeline/guard";
import { listExternalPublications } from "@/lib/publishing/targets";
import { loadSite } from "@/lib/app/store";
import { canEdit, canManage, requireUser, roleIn } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline" | "destructive"> = {
  published: "success",
  draft: "secondary",
  in_review: "warning",
  archived: "outline",
  failed: "destructive",
};

const PAGE_STATUS: Record<string, { label: string; variant: "warning" | "destructive"; title: string }> = {
  noindex: { label: "noindex", variant: "warning", title: "Still served, marked noindex, and left out of the sitemap, feed and llms files." },
  retired: { label: "retired · 410", variant: "destructive", title: "Answers 410 Gone and is listed nowhere." },
};

export default async function ContentPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}/content`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const edit = canEdit(user, site.org_id);
  const manage = canManage(user, site.org_id);
  const [items, publications, guard] = await Promise.all([listContentItems(siteId), listExternalPublications(siteId), publishGuard(siteId)]);
  const pushed = new Map<string, typeof publications>();
  for (const p of publications) pushed.set(p.content_item_id, [...(pushed.get(p.content_item_id) ?? []), p]);
  return (
    <AppShell user={user} site={site} page="content">
      <PageHeader title="Content" eyebrow={site.name} description="Every piece the pipeline has produced, its latest version, QA state and where it is published.">
        <Badge variant="secondary">{items.length} items</Badge>
        {manage ? (
          site.indexing_paused
            ? <ActionButton size="sm" variant="outline" action={setIndexingPausedAction.bind(null, siteId, false)} done="resumed">Resume indexing</ActionButton>
            : <ActionButton size="sm" variant="outline" action={setIndexingPausedAction.bind(null, siteId, true)} done="paused" title="Every page serves noindex, the sitemap, feed and llms files list nothing, and publishing holds until you resume.">Pause indexing</ActionButton>
        ) : null}
      </PageHeader>
      {guard.ok ? null : (
        <Alert variant="warning" className="mb-4">
          <AlertTitle>Publishing is on hold</AlertTitle>
          <AlertDescription>Because {guard.reason}. Runs that reach their publish step wait and check again every hour for up to three days.{site.indexing_paused ? " Every page serves noindex and the sitemap, feed and llms files list nothing until indexing is resumed." : ""}</AlertDescription>
        </Alert>
      )}
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
                    <TableCell>{i.published_path ? <a className="underline-offset-2 hover:underline" href={`https://${site.canonical_domain}${i.published_path}`} target="_blank" rel="noreferrer">{i.published_path}</a> : <span className="text-muted-foreground">not yet</span>}{i.page_status && PAGE_STATUS[i.page_status] ? <div className="text-xs"><Badge variant={PAGE_STATUS[i.page_status]!.variant} title={PAGE_STATUS[i.page_status]!.title}>{PAGE_STATUS[i.page_status]!.label}</Badge></div> : null}{(pushed.get(i.id) ?? []).map((p) => <div key={p.id} className="text-xs">{p.status === "published" ? <Badge variant="success">{p.target_name}</Badge> : p.status === "failed" ? <Badge variant="destructive">{p.target_name} failed</Badge> : <Badge variant="secondary">{p.target_name} {p.status}</Badge>}{p.external_url ? <a className="ml-1 underline-offset-2 hover:underline" href={p.external_url} target="_blank" rel="noreferrer">open</a> : null}</div>)}</TableCell>
                    <TableCell>{when(i.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex gap-2">
                        {i.pending_approval_id ? <Button asChild size="sm"><Link href={`/app/approvals/${i.pending_approval_id}` as Route}>Review {i.pending_kind}</Link></Button> : null}
                        {i.current_version_id ? <Button asChild size="sm" variant="outline"><a href={`/app/preview/${i.current_version_id}`} target="_blank" rel="noreferrer">Preview</a></Button> : null}
                      </span>
                      {edit && i.published_path && i.page_status ? (
                        <span className="mt-1 flex flex-wrap justify-end gap-1">
                          {i.page_status === "live" ? <ActionButton size="sm" variant="ghost" action={setPageStatusAction.bind(null, siteId, i.published_path, "noindex")} done="noindex" title="Keep serving it, but out of the index and every listing.">Noindex</ActionButton> : null}
                          {i.page_status !== "retired" ? <ActionButton size="sm" variant="ghost" action={setPageStatusAction.bind(null, siteId, i.published_path, "retired")} done="retired" title="Answer 410 Gone from the next request.">Retire</ActionButton> : null}
                          {i.page_status !== "live" ? <ActionButton size="sm" variant="ghost" action={setPageStatusAction.bind(null, siteId, i.published_path, "live")} done="restored">Restore</ActionButton> : null}
                          {i.can_rollback && i.page_status !== "retired" ? <ActionButton size="sm" variant="ghost" action={rollbackPageAction.bind(null, siteId, i.published_path)} done="rolled back" title="Republish the version this page replaced, live. No model call; rolling back again undoes it.">Roll back</ActionButton> : null}
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
    </AppShell>
  );
}
