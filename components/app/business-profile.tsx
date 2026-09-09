import { Loader2, RefreshCw } from "lucide-react";
import { ActionButton } from "@/components/app/action-button";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { addKeywordsAction, refreshProfileAction } from "@/lib/app/onboarding-actions";
import type { SiteRow } from "@/lib/app/store";

/**
 * What we learned about the business from its own website, and the
 * keywords it suggests as topics. Server component; the buttons are the
 * shared ActionButton so a click shows its outcome inline.
 */
export function BusinessProfileCard({ site, trackedKeywords, canEdit }: { site: SiteRow; trackedKeywords: string[]; canEdit: boolean }) {
  const tracked = new Set(trackedKeywords.map((k) => k.trim().toLowerCase()));
  const p = site.profile;
  const status = site.profile_status;
  const busy = status === "queued" || status === "running";
  const suggestions = (p?.keywords ?? []).filter((k) => !tracked.has(k.trim().toLowerCase()));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Business profile
          {status === "ready" && p ? <Badge variant="success">from {site.canonical_domain}</Badge> : null}
          {busy ? <Badge variant="secondary"><Loader2 className="mr-1 size-3 animate-spin" />{status === "queued" ? "queued" : "crawling"}</Badge> : null}
          {status === "failed" ? <Badge variant="destructive">failed</Badge> : null}
        </CardTitle>
        <CardDescription>
          {busy ? "Reading the site to learn what the business does. This takes about a minute; refresh the page." : p ? `Extracted ${when(site.profile_updated_at)} from the website crawl. Products and competitors were added to the brand brain as entities.` : "We crawl your own website to learn what the business does, then suggest topics and seed the brand brain."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status === "failed" ? (
          <Alert variant="destructive"><AlertTitle>The crawl did not finish</AlertTitle><AlertDescription>{site.profile_error ?? "Unknown error."}</AlertDescription></Alert>
        ) : null}
        {status === "ready" && !p && site.profile_error ? (
          <Alert variant="warning"><AlertTitle>Crawled, but no profile yet</AlertTitle><AlertDescription>{site.profile_error}</AlertDescription></Alert>
        ) : null}
        {p ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <p className="text-lg font-semibold">{p.name} <span className="text-muted-foreground text-sm font-normal">· {p.category}</span></p>
              <p className="text-sm">{p.oneLiner}</p>
              {p.description ? <p className="text-muted-foreground text-sm">{p.description}</p> : null}
              {p.pricingModel ? <p className="text-sm"><span className="font-medium">Pricing:</span> {p.pricingModel}</p> : null}
              {p.audiences.length ? <p className="text-sm"><span className="font-medium">For:</span> {p.audiences.join(", ")}</p> : null}
              {p.locations.length ? <p className="text-sm"><span className="font-medium">Where:</span> {p.locations.join(", ")}</p> : null}
            </div>
            <div className="grid gap-3">
              {p.products.length ? (
                <div>
                  <p className="mb-1 text-sm font-medium">Products</p>
                  <ul className="grid gap-1 text-sm">{p.products.map((x) => <li key={x.name}><span className="font-medium">{x.name}</span>{x.description ? <span className="text-muted-foreground"> · {x.description}</span> : null}</li>)}</ul>
                </div>
              ) : null}
              {p.differentiators.length ? (
                <div>
                  <p className="mb-1 text-sm font-medium">Differentiators</p>
                  <ul className="text-muted-foreground list-disc pl-4 text-sm">{p.differentiators.map((d) => <li key={d}>{d}</li>)}</ul>
                </div>
              ) : null}
              {p.competitors.length ? (
                <div>
                  <p className="mb-1 text-sm font-medium">Competitors named on the site</p>
                  <div className="flex flex-wrap gap-1">{p.competitors.map((c) => <Badge key={c} variant="outline">{c}</Badge>)}</div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {p ? (
          <div>
            <p className="mb-1 text-sm font-medium">Suggested topics {suggestions.length === 0 && p.keywords.length ? <span className="text-muted-foreground font-normal">· all tracked</span> : null}</p>
            <div className="flex flex-wrap gap-2">
              {p.keywords.map((k) => tracked.has(k.trim().toLowerCase()) ? (
                <Badge key={k} variant="success">{k}</Badge>
              ) : canEdit ? (
                <ActionButton key={k} size="sm" variant="outline" action={addKeywordsAction.bind(null, site.id, k)} done="Added">+ {k}</ActionButton>
              ) : (
                <Badge key={k} variant="outline">{k}</Badge>
              ))}
              {suggestions.length > 1 && canEdit ? <ActionButton size="sm" action={addKeywordsAction.bind(null, site.id, suggestions.join("\n"))} done="Added">Add all {suggestions.length}</ActionButton> : null}
            </div>
          </div>
        ) : null}
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <ActionButton size="sm" variant="outline" action={refreshProfileAction.bind(null, site.id)} done="Crawl queued" disabled={busy}><RefreshCw /> {p ? "Re-crawl site" : status === "failed" ? "Try again" : "Crawl site"}</ActionButton>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
