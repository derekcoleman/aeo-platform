import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { AppShell, PageHeader } from "@/components/app/shell";
import { ThemeForm } from "@/components/app/theme-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadRenderConfig } from "@/lib/app/preview";
import { loadSite } from "@/lib/app/store";
import { extractThemeAction } from "@/lib/app/theme-actions";
import { requireStaff } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ThemePage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const user = await requireStaff();
  const [site, config] = await Promise.all([loadSite(siteId), loadRenderConfig(siteId)]);
  if (!site) notFound();
  const tokenCount = Object.keys(config?.theme.tokens ?? {}).length;
  return (
    <AppShell user={user} active="ops">
      <PageHeader title={`${site.name} · Theme`} description={`${site.canonical_domain}${site.path_prefix} · tokens, header/footer fragments and custom CSS. Data only; no tenant JavaScript.`}>
        <Badge variant={tokenCount ? "secondary" : "warning"}>{tokenCount ? `${tokenCount} tokens` : "default theme"}</Badge>
        <ActionButton size="sm" variant="outline" action={extractThemeAction.bind(null, siteId)} done="Extracted; review and save">Extract from homepage</ActionButton>
        <Button asChild variant="outline" size="sm"><Link href={"/ops" as Route}>Back to ops</Link></Button>
      </PageHeader>
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
          <CardContent><ThemeForm siteId={siteId} theme={config.theme} /></CardContent>
        </Card>
      )}
    </AppShell>
  );
}
