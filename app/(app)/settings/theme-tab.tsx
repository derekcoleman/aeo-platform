import { ActionButton } from "@/components/app/action-button";
import { ThemeForm } from "@/components/app/theme-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadRenderConfig } from "@/lib/app/preview";
import type { SiteRow } from "@/lib/app/store";
import { extractThemeAction } from "@/lib/app/theme-actions";

/** Settings → Theme (staff, per project): tokens, header/footer fragments and custom CSS for the proxied pages. Data only; no tenant JavaScript. */
export async function ThemeTab({ site }: { site: SiteRow }) {
  const config = await loadRenderConfig(site.id);
  const tokenCount = Object.keys(config?.theme.tokens ?? {}).length;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground text-sm">{site.canonical_domain}{site.path_prefix} · tokens, header/footer fragments and custom CSS. Data only; no tenant JavaScript.</p>
        <Badge variant={tokenCount ? "secondary" : "warning"}>{tokenCount ? `${tokenCount} tokens` : "default theme"}</Badge>
        <ActionButton size="sm" variant="outline" action={extractThemeAction.bind(null, site.id)} done="Extracted; review and save">Extract from homepage</ActionButton>
      </div>
      {!config ? (
        <Alert variant="warning">
          <AlertTitle>No render config yet</AlertTitle>
          <AlertDescription>This site has no row in content.site_render_config. It is created when the site is created; re-create the site or seed the row.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Match their site</CardTitle>
            <CardDescription>Twenty minutes of human time to a convincing match. Extract a first pass from the homepage, then tune tokens and fragments with the live preview. Re-check monthly; customers redesign.</CardDescription>
          </CardHeader>
          <CardContent><ThemeForm siteId={site.id} theme={config.theme} /></CardContent>
        </Card>
      )}
    </div>
  );
}
