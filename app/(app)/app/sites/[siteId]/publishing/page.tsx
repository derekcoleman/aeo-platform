import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { FieldMapForm, TargetPicker, WebflowConnectForm, type SiteOption } from "@/components/app/publishing-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listContentItems } from "@/lib/app/content";
import { deleteTargetAction, pushItemAction, testTargetAction } from "@/lib/app/publishing-actions";
import { loadSite } from "@/lib/app/store";
import { canManage, requireUser, roleIn } from "@/lib/auth/session";
import { connectorContext, listConnections } from "@/lib/connectors";
import { webflowClientFor, type WebflowField } from "@/lib/connectors/webflow";
import { listExternalPublications, listPublishTargets } from "@/lib/publishing/targets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PublishingPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireUser(`/app/sites/${siteId}/publishing`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const manage = canManage(user, site.org_id);
  const ctx = connectorContext();
  const [connections, targets, publications, items] = await Promise.all([
    listConnections({ orgId: site.org_id, provider: "webflow" }, ctx.sql),
    listPublishTargets(siteId),
    listExternalPublications(siteId),
    listContentItems(siteId, 100),
  ]);
  const active = connections.filter((c) => c.status === "active" && (c.site_id === null || c.site_id === siteId));

  // Live lookups for the picker and the field-map editors. Failures are shown, never thrown.
  const siteOptions = new Map<string, SiteOption[]>();
  const fieldsByTarget = new Map<string, WebflowField[]>();
  const lookupErrors: string[] = [];
  for (const c of active) {
    try {
      const api = await webflowClientFor(c, ctx);
      const sites = await api.sites();
      const opts: SiteOption[] = [];
      for (const s of sites.slice(0, 10)) {
        const cols = await api.collections(s.id).catch(() => []);
        opts.push({ id: s.id, name: s.displayName, collections: cols.map((x) => ({ id: x.id, name: x.displayName, slug: x.slug })) });
      }
      siteOptions.set(c.id, opts);
      for (const t of targets.filter((t) => t.connection_id === c.id)) {
        const detail = await api.collection(t.config.collectionId).catch(() => null);
        if (detail) fieldsByTarget.set(t.id, detail.fields);
      }
    } catch (e) {
      lookupErrors.push(`${c.external_account_name ?? c.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const published = items.filter((i) => i.status === "published");
  const pubByItem = new Map<string, typeof publications>();
  for (const p of publications) pubByItem.set(p.content_item_id, [...(pubByItem.get(p.content_item_id) ?? []), p]);

  return (
    <AppShell user={user} active="projects">
      <PageHeader title={`${site.name} · Publishing`} description="Where articles go. The proxy serves them on your domain; a Webflow target pushes each one into your CMS as a blog post and keeps it updated.">
        <Badge variant="secondary">{targets.filter((t) => t.enabled).length} target{targets.filter((t) => t.enabled).length === 1 ? "" : "s"}</Badge>
        <Badge variant={publications.some((p) => p.status === "failed") ? "destructive" : "outline"}>{publications.filter((p) => p.status === "published").length} pushed · {publications.filter((p) => p.status === "failed").length} failed</Badge>
        <Button asChild variant="outline" size="sm"><Link href={`/app/sites/${siteId}` as Route}>Back to project</Link></Button>
      </PageHeader>

      {lookupErrors.length ? <Alert variant="warning" className="mb-4"><AlertTitle>Webflow lookup failed</AlertTitle><AlertDescription>{lookupErrors.join(" · ")}</AlertDescription></Alert> : null}

      <div className="grid gap-4">
        <Card>
          <CardHeader><CardTitle>Webflow connection</CardTitle><CardDescription>A site API token with cms:read and cms:write. Stored in Vault; the row keeps a reference only.</CardDescription></CardHeader>
          <CardContent className="grid gap-3">
            {active.length ? active.map((c) => (
              <p key={c.id} className="text-sm"><Badge variant="success">connected</Badge> <span className="ml-2">{c.external_account_name ?? c.external_account_id}</span> <span className="text-muted-foreground text-xs">· {(siteOptions.get(c.id) ?? []).length} site(s) visible</span></p>
            )) : <p className="text-muted-foreground text-sm">Not connected.</p>}
            {manage ? <WebflowConnectForm siteId={siteId} /> : null}
          </CardContent>
        </Card>

        {manage && active.length ? (
          <Card>
            <CardHeader><CardTitle>Add a publish target</CardTitle><CardDescription>Pick the collection that holds your blog posts. We read its fields and suggest a map you can change.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              {active.map((c) => <TargetPicker key={c.id} siteId={siteId} connectionId={c.id} sites={siteOptions.get(c.id) ?? []} />)}
            </CardContent>
          </Card>
        ) : null}

        {targets.map((t) => (
          <Card key={t.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">{t.name} {t.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="outline">disabled</Badge>}{t.config.autoPush !== false ? <Badge variant="secondary">auto push</Badge> : null}{t.config.publishLive ? <Badge variant="secondary">live</Badge> : <Badge variant="outline">staged</Badge>}</CardTitle>
              <CardDescription>{t.config.siteName} → collection “{t.config.collectionName}”. Canonical: {t.config.canonicalMode}.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {manage ? (
                <div className="flex flex-wrap gap-2">
                  <ActionButton size="sm" variant="outline" action={testTargetAction.bind(null, siteId, t.id)} done="Connection OK">Test connection</ActionButton>
                  <ActionButton size="sm" variant="ghost" action={deleteTargetAction.bind(null, siteId, t.id)} done="Removed">Remove target</ActionButton>
                </div>
              ) : null}
              {manage && fieldsByTarget.get(t.id) ? (
                <FieldMapForm targetId={t.id} fields={fieldsByTarget.get(t.id)!} fieldMap={t.config.fieldMap} publishLive={t.config.publishLive} autoPush={t.config.autoPush !== false} enabled={t.enabled} canonicalMode={t.config.canonicalMode} />
              ) : (
                <p className="text-muted-foreground text-xs">Field map: {Object.entries(t.config.fieldMap).filter(([, v]) => v).map(([k, v]) => `${k} → ${v}`).join(" · ")}</p>
              )}
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader><CardTitle>Push status</CardTitle><CardDescription>Every published article and where it has been pushed. Re-push updates the same Webflow item.</CardDescription></CardHeader>
          <CardContent>
            {published.length === 0 ? <p className="text-muted-foreground text-sm">Nothing published yet.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Article</TableHead><TableHead>Targets</TableHead><TableHead></TableHead></TableRow></TableHeader>
                <TableBody>
                  {published.map((i) => {
                    const pubs = pubByItem.get(i.id) ?? [];
                    return (
                      <TableRow key={i.id}>
                        <TableCell className="max-w-sm"><p className="truncate font-medium">{i.title ?? i.slug}</p><p className="text-muted-foreground font-mono text-xs">{i.published_path}</p></TableCell>
                        <TableCell>
                          {targets.filter((t) => t.kind === "webflow").map((t) => {
                            const p = pubs.find((x) => x.target_id === t.id);
                            return (
                              <div key={t.id} className="flex flex-wrap items-center gap-2 text-xs">
                                <span>{t.name}:</span>
                                {!p ? <Badge variant="outline">not pushed</Badge> : p.status === "published" ? <Badge variant="success">pushed {when(p.published_at)}</Badge> : p.status === "failed" ? <Badge variant="destructive">failed</Badge> : <Badge variant="secondary">{p.status}</Badge>}
                                {p?.external_url ? <a className="underline-offset-2 hover:underline" href={p.external_url} target="_blank" rel="noreferrer">open</a> : p?.external_id ? <span className="text-muted-foreground font-mono">{p.external_id}</span> : null}
                                {p?.last_error ? <span className="text-destructive">{p.last_error.slice(0, 120)}</span> : null}
                              </div>
                            );
                          })}
                          {targets.filter((t) => t.kind === "webflow").length === 0 ? <span className="text-muted-foreground text-xs">no Webflow target</span> : null}
                        </TableCell>
                        <TableCell className="text-right">{manage && targets.some((t) => t.kind === "webflow" && t.enabled) ? <ActionButton size="sm" variant="outline" action={pushItemAction.bind(null, siteId, i.id, null, true)} done="Push queued">{pubs.length ? "Re-push" : "Push now"}</ActionButton> : null}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
