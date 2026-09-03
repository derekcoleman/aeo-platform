import Link from "next/link";
import type { Route } from "next";
import { Globe } from "lucide-react";
import { CreateOrgDialog, CreateSiteDialog } from "@/components/app/create-dialogs";
import { AppShell, PageHeader } from "@/components/app/shell";
import { HealthBadge, SiteStatusBadge, when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listOrganizations, listSites } from "@/lib/app/store";
import { canManage, requireUser, visibleOrgIds } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requireUser();
  const { denied } = await searchParams;
  const scope = visibleOrgIds(user);
  const [orgs, sites] = await Promise.all([listOrganizations(scope), listSites(scope)]);
  const manageable = orgs.filter((o) => canManage(user, o.id));
  return (
    <AppShell user={user} active="projects">
      <PageHeader title="Projects" description="One project per domain and path prefix. Each gets its own edge hostname, install guide, health monitor and content queue.">
        <CreateOrgDialog first={orgs.length === 0} />
        <CreateSiteDialog orgs={manageable.map((o) => ({ id: o.id, name: o.name }))} />
      </PageHeader>
      {denied === "ops" ? <Alert variant="warning" className="mb-6"><AlertTitle>Staff only</AlertTitle><AlertDescription>The ops console is limited to internal staff.</AlertDescription></Alert> : null}
      {orgs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Start with an organisation</CardTitle>
            <CardDescription>Create the organisation that owns your projects, then add the first domain.</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {orgs.map((org) => {
        const own = sites.filter((s) => s.org_id === org.id);
        return (
          <section key={org.id} className="mb-10">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-lg font-medium">{org.name}</h2>
              <span className="text-muted-foreground text-xs">{org.plan} · {own.length} project{own.length === 1 ? "" : "s"}</span>
            </div>
            {own.length === 0 ? (
              <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">No projects yet. Add a domain to get its install guide.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {own.map((s) => (
                  <Link key={s.id} href={`/app/sites/${s.id}` as Route} className="group">
                    <Card className="h-full transition-colors group-hover:border-foreground/30">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2"><Globe className="text-muted-foreground size-4" /> {s.name}</CardTitle>
                        <CardDescription className="font-mono">{s.canonical_domain}{s.path_prefix}</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-wrap items-center gap-2 text-xs">
                        <SiteStatusBadge status={s.status} />
                        <HealthBadge ok={s.last_health_ok} failures={s.health_failures} />
                        <span className="text-muted-foreground ml-auto">{s.last_health_at ? `checked ${when(s.last_health_at)}` : "never checked"}</span>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </AppShell>
  );
}
