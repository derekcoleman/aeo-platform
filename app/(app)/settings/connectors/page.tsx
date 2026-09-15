import type { Route } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/app/action-button";
import { CustomConnectorForm, GoogleConfigForm, OAuthConnect, SiteScopedConnect, SlackChannelsForm, type SiteOption } from "@/components/app/connector-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { SyncStatus } from "@/components/app/sync-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { disconnectConnectionAction, ensureWebsiteConnectionAction, syncConnectionAction } from "@/lib/app/connector-actions";
import { connectorsOverview, type CatalogEntryView, type ConnectionView, type ConnectorsOverview } from "@/lib/app/connectors";
import { listOrganizations } from "@/lib/app/store";
import { canManage, requireUser, visibleOrgIds } from "@/lib/auth/session";
import { GROUP_LABELS, STATE_LABELS, type ConnectorGroup, type ConnectorState } from "@/lib/connectors/catalog";
import type { CustomConfig } from "@/lib/connectors/custom";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_VARIANT: Record<ConnectorState, "success" | "warning" | "destructive" | "outline"> = { connected: "success", needs_setup: "warning", error: "destructive", not_connected: "outline" };

/**
 * Every connector the product offers, per organisation, connected or not.
 * Each card says what the connector feeds, what is connected (with the sync
 * state and the configuration it still needs), and how to connect another.
 */
export default async function ConnectorsPage({ searchParams }: { searchParams: Promise<{ connector?: string; error?: string; connected?: string }> }) {
  const user = await requireUser("/settings/connectors");
  const { connector, error, connected } = await searchParams;
  const orgs = await listOrganizations(visibleOrgIds(user));
  const overviews = await Promise.all(orgs.map(async (o) => ({ org: o, manage: canManage(user, o.id), overview: await connectorsOverview(o.id) })));
  return (
    <AppShell user={user} active="connectors">
      <PageHeader title="Connectors" description="Everything the platform can read from or publish to, whether it is connected yet or not. Tokens live in Vault; every sync writes a run row, so a failing connector shows here, never silently." />
      {error ? <Alert variant="destructive" className="mb-6"><AlertTitle>{connector ?? "Connector"} did not connect</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {connected ? <Alert variant="success" className="mb-6"><AlertTitle>{connected} connected</AlertTitle><AlertDescription>{connected === "google" ? "Now pick the Search Console property and the GA4 property on the cards below; nothing is read until you do." : connected === "slack" ? "Now pick the channels to read and where approvals should post; nothing is read until you do." : "The first sync is queued."}</AlertDescription></Alert> : null}
      {overviews.map(({ org, manage, overview }) => (
        <section key={org.id} className="mb-10">
          {overviews.length > 1 ? <h2 className="mb-3 text-lg font-semibold">{org.name}</h2> : null}
          {(Object.keys(GROUP_LABELS) as ConnectorGroup[]).map((group) => (
            <div key={group} className="mb-6">
              <h3 className="text-muted-foreground mb-1 text-[11px] font-medium tracking-wide uppercase">{GROUP_LABELS[group].title}</h3>
              <p className="text-muted-foreground mb-3 text-sm">{GROUP_LABELS[group].blurb}</p>
              <div className="grid gap-4">
                {overview.entries.filter((e) => e.def.group === group).map((entry) => <ConnectorCard key={entry.def.key} entry={entry} orgId={org.id} manage={manage} overview={overview} />)}
              </div>
            </div>
          ))}
        </section>
      ))}
    </AppShell>
  );
}

function ConnectorCard({ entry, orgId, manage, overview }: { entry: CatalogEntryView; orgId: string; manage: boolean; overview: ConnectorsOverview }) {
  const { def } = entry;
  const sites: SiteOption[] = overview.sites.map((s) => ({ id: s.id, name: s.name, domain: s.canonical_domain }));
  const connectedSiteIds = new Set(entry.connections.map((c) => c.row.site_id).filter((s): s is string => !!s));
  const sitesWithout = sites.filter((s) => !connectedSiteIds.has(s.id));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {def.name}
          <Badge variant={STATE_VARIANT[entry.state]}>{STATE_LABELS[entry.state]}{entry.connections.length > 1 ? ` · ${entry.connections.length}` : ""}</Badge>
          <Badge variant="outline">{def.scope === "site" ? "per project" : "organisation"}</Badge>
        </CardTitle>
        <CardDescription>{def.tagline}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-muted-foreground text-sm">{def.description}</p>
        <p className="text-muted-foreground text-xs">Feeds: {def.feeds.join(" · ")}</p>

        {entry.connections.map((c) => <ConnectionRowView key={c.row.id} entry={entry} c={c} manage={manage} overview={overview} />)}

        {manage ? (
          <div className="rounded-lg border border-dashed p-3">
            <p className="mb-2 text-sm font-medium">{entry.connections.length ? (def.scope === "site" ? "Connect another project" : "Add another") : "Connect"}</p>
            <ConnectPanel entry={entry} orgId={orgId} sites={def.scope === "site" ? sitesWithout : sites} allSites={sites} overview={overview} />
          </div>
        ) : entry.connections.length === 0 ? <p className="text-muted-foreground text-xs">Owners and admins can connect this.</p> : null}
      </CardContent>
    </Card>
  );
}

function ConnectionRowView({ entry, c, manage, overview }: { entry: CatalogEntryView; c: ConnectionView; manage: boolean; overview: ConnectorsOverview }) {
  const { def } = entry;
  const row = c.row;
  const cfg = row.config as Record<string, unknown>;
  const label = def.provider === "google" ? (def.key === "gsc" ? (cfg.gscProperty as string | null) ?? null : (cfg.ga4PropertyId as string | null) ?? null) : row.external_account_name ?? row.external_account_id;
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium">
            {c.site ? <Link className="underline-offset-2 hover:underline" href={`/app/sites/${c.site.id}` as Route}>{c.site.name}</Link> : "Organisation"}
            {label ? <span className="text-muted-foreground"> · {label}</span> : null}
            {def.provider === "google" && row.external_account_name ? <span className="text-muted-foreground"> · {row.external_account_name}</span> : null}
            {def.provider === "custom" ? <span className="text-muted-foreground"> · {(row.config as CustomConfig).kind.toUpperCase()} · {(row.config as CustomConfig).url}</span> : null}
          </p>
          <p className="text-muted-foreground text-xs">
            <Badge variant={STATE_VARIANT[c.state]}>{STATE_LABELS[c.state]}</Badge>
            <span className="ml-2">last sync {when(row.last_synced_at)}</span>
            {row.last_error ? <span className="text-destructive ml-2">{row.last_error.slice(0, 140)}</span> : null}
          </p>
        </div>
        {manage ? (
          <span className="flex flex-wrap gap-2">
            {c.state !== "needs_setup" && !(def.provider === "profound" && cfg.mode !== "api") ? <ActionButton size="sm" variant="outline" action={syncConnectionAction.bind(null, row.id)} done="Queued">Sync now</ActionButton> : null}
            {def.provider !== "google" || def.key === "gsc" ? <ActionButton size="sm" variant="ghost" action={disconnectConnectionAction.bind(null, row.id)} done="Disconnected">Disconnect</ActionButton> : null}
          </span>
        ) : null}
      </div>
      {c.sync.phase !== "idle" ? <SyncStatus state={c.sync} /> : null}
      {manage && def.provider === "google" ? (
        <GoogleConfigForm connectionId={row.id} focus={def.key === "gsc" ? "gsc" : "ga4"} gsc={overview.google.get(row.id)?.gsc ?? []} ga4={overview.google.get(row.id)?.ga4 ?? []} current={{ gscProperty: (cfg.gscProperty as string | null) ?? null, ga4PropertyId: (cfg.ga4PropertyId as string | null) ?? null }} lookupError={overview.google.get(row.id)?.error ?? null} />
      ) : null}
      {manage && def.provider === "slack" ? (
        <SlackChannelsForm connectionId={row.id} channels={overview.slack.get(row.id)?.channels ?? []} selected={row.scope} approvalsChannel={(cfg.approvalsChannel as string | null) ?? null} alertsChannel={(cfg.alertsChannel as string | null) ?? null} lookupError={overview.slack.get(row.id)?.error ?? null} />
      ) : null}
      {def.provider === "profound" && cfg.mode !== "api" ? <p className="text-muted-foreground text-xs">CSV connection: upload exports under the project&apos;s Strategy → Visibility.</p> : null}
      {def.provider === "webflow" && c.site ? <p className="text-muted-foreground text-xs">Publish targets and the field map live under <Link className="underline-offset-2 hover:underline" href={`/app/sites/${c.site.id}/publishing` as Route}>Publishing</Link>; the CMS inventory under <Link className="underline-offset-2 hover:underline" href={`/app/sites/${c.site.id}/refresh` as Route}>Refresh</Link>.</p> : null}
    </div>
  );
}

function ConnectPanel({ entry, orgId, sites, allSites, overview }: { entry: CatalogEntryView; orgId: string; sites: SiteOption[]; allSites: SiteOption[]; overview: ConnectorsOverview }) {
  const { def } = entry;
  switch (def.key) {
    case "gsc":
    case "ga4": {
      // One Google grant serves both cards: a project that already has one only needs the property picked above.
      const granted = new Set(overview.entries.filter((e) => e.def.provider === "google").flatMap((e) => e.connections.map((c) => c.row.site_id)));
      const remaining = allSites.filter((s) => !granted.has(s.id));
      if (remaining.length === 0 && allSites.length > 0) return <p className="text-muted-foreground text-xs">Every project has a Google grant; pick the {def.key === "gsc" ? "Search Console" : "GA4"} property above. To use a different Google account, disconnect and reconnect.</p>;
      return <OAuthConnect provider="google" orgId={orgId} sites={remaining} label="Connect Google (Search Console + GA4)" ready={overview.oauthReady.google} siteScoped />;
    }
    case "slack":
      if (entry.connections.length > 0) return <p className="text-muted-foreground text-xs">One Slack workspace per organisation. Disconnect to install into a different one.</p>;
      return <OAuthConnect provider="slack" orgId={orgId} sites={allSites} label="Add to Slack" ready={overview.oauthReady.slack} siteScoped={false} />;
    case "profound":
      return <SiteScopedConnect kind="profound" sites={sites} />;
    case "webflow":
      return <SiteScopedConnect kind="webflow" sites={sites} />;
    case "website":
      if (sites.length === 0) return <p className="text-muted-foreground text-xs">Every project&apos;s site is being crawled.</p>;
      return (
        <div className="flex flex-wrap gap-2">
          {sites.map((s) => <ActionButton key={s.id} size="sm" variant="outline" action={ensureWebsiteConnectionAction.bind(null, s.id)} done="Crawl queued">Crawl {s.domain}</ActionButton>)}
        </div>
      );
    case "custom":
      return <CustomConnectorForm orgId={orgId} sites={allSites} />;
  }
}
