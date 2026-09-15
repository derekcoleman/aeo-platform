import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { CustomConnectorForm, GoogleConfigForm, OAuthConnect, SiteScopedConnect, SlackChannelsForm, type SiteOption } from "@/components/app/connector-forms";
import { ConnectorTile } from "@/components/app/connector-tile";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { SyncStatus } from "@/components/app/sync-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { disconnectConnectionAction, ensureWebsiteConnectionAction, syncConnectionAction } from "@/lib/app/connector-actions";
import { connectorsOverview, type CatalogEntryView, type ConnectionView, type ConnectorsOverview } from "@/lib/app/connectors";
import { loadSite, type SiteRow } from "@/lib/app/store";
import { canManage, requireUser, roleIn } from "@/lib/auth/session";
import { GROUP_LABELS, STATE_LABELS, type ConnectorGroup, type ConnectorState } from "@/lib/connectors/catalog";
import type { CustomConfig } from "@/lib/connectors/custom";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_VARIANT: Record<ConnectorState, "success" | "warning" | "destructive" | "outline"> = { connected: "success", needs_setup: "warning", error: "destructive", not_connected: "outline" };

/**
 * The project's connectors: a compact grid of tiles, one per connector the
 * product offers, connected or not. A tile opens a dialog with the rows that
 * exist, their sync state, and the way to connect or finish setting up.
 */
export default async function SiteConnectorsPage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ connector?: string; error?: string; connected?: string }> }) {
  const { siteId } = await params;
  const { connector, error, connected } = await searchParams;
  const user = await requireUser(`/app/sites/${siteId}/connectors`);
  const site = await loadSite(siteId);
  if (!site || !roleIn(user, site.org_id)) notFound();
  const manage = canManage(user, site.org_id);
  const overview = await connectorsOverview(site.org_id, { siteId });
  const connectedCount = overview.entries.filter((e) => e.state === "connected").length;
  const attention = overview.entries.filter((e) => e.state === "needs_setup" || e.state === "error").length;

  return (
    <AppShell user={user} site={site} page="connectors">
      <div className="max-w-3xl">
        <PageHeader title="Connectors" eyebrow={site.name} description="What this project reads from and publishes to. Click a tile to connect it or finish setting it up.">
          <Badge variant="secondary">{connectedCount} of {overview.entries.length} connected</Badge>
          {attention ? <Badge variant="warning">{attention} need attention</Badge> : null}
        </PageHeader>

        {error ? <Alert variant="destructive" className="mb-4"><AlertTitle>{connector ?? "Connector"} did not connect</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        {connected ? <Alert variant="success" className="mb-4"><AlertTitle>{connected} connected</AlertTitle><AlertDescription>{connected === "google" ? "Open the Search Console and GA4 tiles to pick the properties; nothing is read until you do." : connected === "slack" ? "Open the Slack tile to pick the channels to read and where approvals should post." : "The first sync is queued."}</AlertDescription></Alert> : null}

        {(Object.keys(GROUP_LABELS) as ConnectorGroup[]).map((group) => (
          <section key={group} className="mb-6">
            <h2 className="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase">{GROUP_LABELS[group].title}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {overview.entries.filter((e) => e.def.group === group).map((entry) => (
                <ConnectorTile key={entry.def.key} name={entry.def.name} tagline={entry.def.tagline} state={entry.state} count={entry.connections.length} scope={entry.def.scope}>
                  <Details entry={entry} site={site} manage={manage} overview={overview} />
                </ConnectorTile>
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}

function Details({ entry, site, manage, overview }: { entry: CatalogEntryView; site: SiteRow; manage: boolean; overview: ConnectorsOverview }) {
  const { def } = entry;
  const sites: SiteOption[] = [{ id: site.id, name: site.name, domain: site.canonical_domain }];
  return (
    <>
      <p className="text-sm">{def.description}</p>
      <p className="text-muted-foreground text-xs">Feeds: {def.feeds.join(" · ")}</p>
      {entry.connections.map((c) => <ConnectionRowView key={c.row.id} entry={entry} c={c} manage={manage} overview={overview} />)}
      {manage ? (
        <div className="rounded-lg border border-dashed p-3">
          <p className="mb-2 text-sm font-medium">{entry.connections.length ? (def.scope === "org" ? "Add another" : "Reconnect") : "Connect"}</p>
          <ConnectPanel entry={entry} site={site} sites={sites} overview={overview} />
        </div>
      ) : entry.connections.length === 0 ? <p className="text-muted-foreground text-xs">Owners and admins can connect this.</p> : null}
    </>
  );
}

function ConnectionRowView({ entry, c, manage, overview }: { entry: CatalogEntryView; c: ConnectionView; manage: boolean; overview: ConnectorsOverview }) {
  const { def } = entry;
  const row = c.row;
  const cfg = row.config as Record<string, unknown>;
  const label = def.provider === "google" ? (def.key === "gsc" ? ((cfg.gscProperty as string | null) ?? null) : ((cfg.ga4PropertyId as string | null) ?? null)) : row.external_account_name ?? row.external_account_id;
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="truncate font-medium">
            {label ?? (def.scope === "org" ? "Organisation" : "This project")}
            {def.provider === "google" && row.external_account_name ? <span className="text-muted-foreground"> · {row.external_account_name}</span> : null}
            {def.provider === "custom" ? <span className="text-muted-foreground"> · {(row.config as CustomConfig).kind.toUpperCase()} · {(row.config as CustomConfig).url}</span> : null}
          </p>
          <p className="text-muted-foreground text-xs">
            <Badge variant={STATE_VARIANT[c.state]}>{STATE_LABELS[c.state]}</Badge>
            <span className="ml-2">last sync {when(row.last_synced_at)}</span>
            {c.row.site_id === null && def.scope === "org" ? <span className="ml-2">· whole organisation</span> : null}
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
      {def.provider === "profound" && cfg.mode !== "api" ? <p className="text-muted-foreground text-xs">CSV connection: upload exports under Strategy → Visibility.</p> : null}
      {def.provider === "webflow" && c.site ? <p className="text-muted-foreground text-xs">Publish targets and the field map live under <Link className="underline-offset-2 hover:underline" href={`/app/sites/${c.site.id}/publishing` as Route}>Publishing</Link>; the CMS inventory under <Link className="underline-offset-2 hover:underline" href={`/app/sites/${c.site.id}/refresh` as Route}>Refresh</Link>.</p> : null}
    </div>
  );
}

function ConnectPanel({ entry, site, sites, overview }: { entry: CatalogEntryView; site: SiteRow; sites: SiteOption[]; overview: ConnectorsOverview }) {
  const { def } = entry;
  const returnTo = `/app/sites/${site.id}/connectors`;
  switch (def.key) {
    case "gsc":
    case "ga4": {
      const granted = overview.entries.some((e) => e.def.provider === "google" && e.connections.length > 0);
      if (granted) return <p className="text-muted-foreground text-xs">This project has a Google grant; pick the {def.key === "gsc" ? "Search Console" : "GA4"} property above. To use a different Google account, disconnect and reconnect.</p>;
      return <OAuthConnect provider="google" orgId={site.org_id} sites={sites} label="Connect Google (Search Console + GA4)" ready={overview.oauthReady.google} siteScoped returnTo={returnTo} />;
    }
    case "slack":
      if (entry.connections.length > 0) return <p className="text-muted-foreground text-xs">One Slack workspace per organisation. Disconnect to install into a different one.</p>;
      return <OAuthConnect provider="slack" orgId={site.org_id} sites={sites} label="Add to Slack" ready={overview.oauthReady.slack} siteScoped={false} returnTo={returnTo} />;
    case "profound":
      if (entry.connections.length > 0) return <p className="text-muted-foreground text-xs">Disconnect first to connect a different key or category.</p>;
      return <SiteScopedConnect kind="profound" sites={sites} />;
    case "webflow":
      if (entry.connections.length > 0) return <p className="text-muted-foreground text-xs">Disconnect first to connect a different token.</p>;
      return <SiteScopedConnect kind="webflow" sites={sites} />;
    case "website":
      if (entry.connections.length > 0) return <p className="text-muted-foreground text-xs">{site.canonical_domain} is crawled daily.</p>;
      return <ActionButton size="sm" variant="outline" action={ensureWebsiteConnectionAction.bind(null, site.id)} done="Crawl queued">Crawl {site.canonical_domain}</ActionButton>;
    case "custom":
      return <CustomConnectorForm orgId={site.org_id} sites={sites} />;
  }
}
