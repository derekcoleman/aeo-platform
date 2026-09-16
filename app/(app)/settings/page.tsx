import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { InviteForm, SettingsForm } from "@/components/app/org-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/app/url-tabs";
import { legacySettingsTab, resolveTab, settingsHref, settingsSections } from "@/lib/app/nav";
import { auditLog, listInvites, listMembers, loadOrg } from "@/lib/app/org";
import { openPortalAction, removeMemberAction, revokeInviteAction, setMemberRoleAction, startCheckoutAction } from "@/lib/app/org-actions";
import { listOrganizations, listSites, loadSite } from "@/lib/app/store";
import { canManage, requireUser, roleIn, visibleOrgIds } from "@/lib/auth/session";
import { PLANS, stripeConfigured } from "@/lib/billing/stripe";
import { ConnectorsTab } from "./connectors-tab";
import { DeploymentTab } from "./deployment-tab";
import { StaffTab } from "./staff-tab";
import { ThemeTab } from "./theme-tab";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** How many organisations the header switches between by name before it points at Ops. */
const ORG_PICKER_MAX = 12;

/**
 * The settings hub: everything that configures the workspace, in one place
 * and apart from the project pages. General, Members, Billing, Connectors
 * and Audit log belong to one organisation; staff also get the project's
 * Theme, the Deployment checklist and the Staff list. `?site=` keeps that
 * project in the sidebar and selects its organisation; `?org=` selects one
 * directly; neither picks the caller's first. Only the open tab's data is
 * loaded: switching tabs re-renders on the server through the URL.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ checkout?: string; tab?: string; site?: string; org?: string; connector?: string; error?: string; connected?: string }> }) {
  const { checkout, tab: requestedTab, site: siteParam, org: orgParam, connector, error, connected } = await searchParams;
  const user = await requireUser(settingsHref(siteParam, orgParam, requestedTab));
  const [orgs, siteCandidate] = await Promise.all([listOrganizations(visibleOrgIds(user)), siteParam ? loadSite(siteParam) : Promise.resolve(null)]);
  const site = siteCandidate && roleIn(user, siteCandidate.org_id) ? siteCandidate : null;
  const orgId = (orgParam && orgs.some((o) => o.id === orgParam) ? orgParam : null) ?? site?.org_id ?? orgs[0]?.id ?? null;
  if (!orgId) {
    return (
      <AppShell user={user} active="settings" page="settings">
        <PageHeader title="Settings" description="Settings belong to an organisation." />
        <Card><CardHeader><CardTitle>No organisation yet</CardTitle><CardDescription>Create one from the <Link className="underline-offset-2 hover:underline" href={"/app" as Route}>projects page</Link>; its members, plan and connectors will live here.</CardDescription></CardHeader></Card>
      </AppShell>
    );
  }
  const role = roleIn(user, orgId);
  if (!role) notFound();
  const siteForOrg = site && site.org_id === orgId ? site : null;
  const sections = settingsSections({ isStaff: user.isStaff, hasSite: !!siteForOrg });
  const tab = resolveTab(sections, legacySettingsTab(requestedTab), checkout ? "billing" : "general");
  const [org, members, invites, audit, orgSites] = await Promise.all([
    loadOrg(orgId),
    tab === "members" ? listMembers(orgId) : Promise.resolve([]),
    tab === "members" ? listInvites(orgId) : Promise.resolve([]),
    tab === "audit" ? auditLog(orgId, 50) : Promise.resolve([]),
    tab === "connectors" && !siteForOrg ? listSites([orgId]) : Promise.resolve([]),
  ]);
  if (!org) notFound();
  const isOwner = role === "owner" || user.isStaff;
  const isAdmin = isOwner || role === "admin";
  const billingOn = stripeConfigured();
  return (
    <AppShell user={user} active="settings" site={siteForOrg} page="settings" section={tab}>
      <PageHeader title="Settings" eyebrow={siteForOrg ? `${siteForOrg.name} · ${org.name}` : org.name} description={siteForOrg ? "This project's connectors and theme, and everything about its organisation." : "Everything about this organisation: people, plan, connectors and history."}>
        <Badge variant={org.plan_status === "active" ? "success" : org.plan_status === "past_due" ? "destructive" : "secondary"}>{org.plan} · {org.plan_status}</Badge>
      </PageHeader>
      {orgs.length > 1 ? (
        <div className="text-muted-foreground mb-6 flex flex-wrap items-center gap-2 text-sm">
          <span>Organisation:</span>
          {orgs.slice(0, ORG_PICKER_MAX).map((o) => (
            o.id === orgId
              ? <Badge key={o.id} variant="default">{o.name}</Badge>
              : <Link key={o.id} href={settingsHref(null, o.id, tab) as Route} className="hover:text-foreground underline-offset-2 hover:underline">{o.name}</Link>
          ))}
          {orgs.length > ORG_PICKER_MAX ? <span>and {orgs.length - ORG_PICKER_MAX} more (see Ops → Organisations)</span> : null}
        </div>
      ) : null}
      {checkout === "success" ? <Alert variant="success" className="mb-4"><AlertTitle>Thanks</AlertTitle><AlertDescription>Your subscription is being confirmed; the plan updates as soon as Stripe notifies us.</AlertDescription></Alert> : null}
      {checkout === "cancel" ? <Alert className="mb-4"><AlertTitle>Checkout cancelled</AlertTitle><AlertDescription>No changes were made.</AlertDescription></Alert> : null}

      <UrlTabs defaultValue={checkout ? "billing" : "general"} values={sections.map((s) => s.value)}>
        <TabsList className="flex-wrap">
          {sections.map((s) => <TabsTrigger key={s.value} value={s.value}>{s.label}</TabsTrigger>)}
        </TabsList>

        <TabsContent value="general" className="grid gap-4 pt-4">
          {tab === "general" ? (
            <Card>
              <CardHeader><CardTitle>Organisation</CardTitle><CardDescription>Name, billing email, retention and budgets. Owners only; every change is audited.</CardDescription></CardHeader>
              <CardContent>{isOwner ? <SettingsForm org={org} isStaff={user.isStaff} /> : <p className="text-muted-foreground text-sm">Ask an owner to change organisation settings.</p>}</CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="members" className="grid gap-4 pt-4">
          {tab === "members" ? (
            <>
              <Card>
                <CardHeader><CardTitle>Members</CardTitle><CardDescription>Owners manage billing, settings and everyone. Admins manage editors and viewers. Editors approve and publish. Viewers read.</CardDescription></CardHeader>
                <CardContent className="grid gap-4">
                  <Table>
                    <TableHeader><TableRow><TableHead>Member</TableHead><TableHead>Role</TableHead><TableHead>Since</TableHead><TableHead></TableHead></TableRow></TableHeader>
                    <TableBody>
                      {members.map((m) => (
                        <TableRow key={m.user_id}>
                          <TableCell><p className="font-medium">{m.name ?? m.email}</p>{m.name ? <p className="text-muted-foreground text-xs">{m.email}</p> : null}</TableCell>
                          <TableCell><Badge variant={m.role === "owner" ? "default" : "secondary"}>{m.role}</Badge></TableCell>
                          <TableCell>{when(m.created_at)}</TableCell>
                          <TableCell className="text-right">
                            {isAdmin && m.user_id !== user.id ? (
                              <span className="inline-flex flex-wrap justify-end gap-1">
                                {(isOwner ? (["owner", "admin", "editor", "viewer"] as const) : (["editor", "viewer"] as const)).filter((r) => r !== m.role).map((r) => (
                                  <ActionButton key={r} size="sm" variant="ghost" action={setMemberRoleAction.bind(null, orgId, m.user_id, r)} done="Updated">→ {r}</ActionButton>
                                ))}
                                <ActionButton size="sm" variant="ghost" action={removeMemberAction.bind(null, orgId, m.user_id)} done="Removed">Remove</ActionButton>
                              </span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {isAdmin ? <InviteForm orgId={orgId} canInviteAdmins={isOwner} /> : null}
                </CardContent>
              </Card>
              {invites.length ? (
                <Card>
                  <CardHeader><CardTitle>Pending invites</CardTitle><CardDescription>Accepted automatically when the person signs in with that email. Expire after 14 days.</CardDescription></CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Invited by</TableHead><TableHead>Expires</TableHead><TableHead></TableHead></TableRow></TableHeader>
                      <TableBody>
                        {invites.map((i) => (
                          <TableRow key={i.id}>
                            <TableCell>{i.email}</TableCell>
                            <TableCell><Badge variant="secondary">{i.role}</Badge></TableCell>
                            <TableCell className="text-xs">{i.invited_by_email ?? "—"}</TableCell>
                            <TableCell>{when(i.expires_at)}</TableCell>
                            <TableCell className="text-right">{isAdmin ? <ActionButton size="sm" variant="ghost" action={revokeInviteAction.bind(null, orgId, i.id)} done="Revoked">Revoke</ActionButton> : null}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ) : null}
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="billing" className="grid gap-4 pt-4">
          {tab === "billing" ? (
            <>
              {!billingOn ? (
                <Alert variant="warning">
                  <AlertTitle>Billing is not configured</AlertTitle>
                  <AlertDescription>Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the three STRIPE_PRICE_* ids, and point a Stripe webhook at /api/webhooks/stripe. Plans below are shown for reference.</AlertDescription>
                </Alert>
              ) : null}
              <div className="grid gap-4 md:grid-cols-3">
                {PLANS.map((p) => {
                  const current = org.plan === p.key;
                  return (
                    <Card key={p.key} className={current ? "border-foreground/40" : undefined}>
                      <CardHeader>
                        <CardTitle className="flex items-center justify-between">{p.name}{current ? <Badge variant="success">current</Badge> : null}</CardTitle>
                        <CardDescription>{p.blurb}</CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-3">
                        <p className="text-3xl font-semibold tabular-nums">${p.monthlyUsd.toLocaleString()}<span className="text-muted-foreground text-sm font-normal">/mo</span></p>
                        <ul className="text-muted-foreground list-disc pl-4 text-sm">{p.includes.map((i) => <li key={i}>{i}</li>)}</ul>
                        {isOwner && billingOn && !current ? <ActionButton action={startCheckoutAction.bind(null, orgId, p.key)} done="Redirecting…">{org.stripe_customer_id ? "Switch to this plan" : "Choose this plan"}</ActionButton> : null}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              {isOwner && org.stripe_customer_id ? (
                <Card>
                  <CardHeader><CardTitle>Invoices and payment method</CardTitle><CardDescription>Managed in the Stripe billing portal. {org.billing_email ? `Receipts go to ${org.billing_email}.` : ""}</CardDescription></CardHeader>
                  <CardContent><ActionButton variant="outline" action={openPortalAction.bind(null, orgId)} done="Redirecting…">Open billing portal</ActionButton></CardContent>
                </Card>
              ) : null}
              {org.plan_status === "trialing" ? <p className="text-muted-foreground text-xs">Trial ends {when(org.trial_ends_at)}.</p> : null}
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="connectors" className="pt-4">
          {tab === "connectors" ? <ConnectorsTab site={siteForOrg} orgSites={orgSites} manage={canManage(user, orgId)} notice={{ connector, error, connected }} /> : null}
        </TabsContent>

        <TabsContent value="audit" className="pt-4">
          {tab === "audit" ? (
            <Card>
              <CardHeader><CardTitle>Audit log</CardTitle><CardDescription>Who changed what in this organisation, newest first.</CardDescription></CardHeader>
              <CardContent>
                {audit.length === 0 ? <p className="text-muted-foreground text-sm">Nothing recorded yet.</p> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {audit.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="whitespace-nowrap">{when(a.at)}</TableCell>
                          <TableCell className="text-xs">{a.actor_email ?? "system"}</TableCell>
                          <TableCell className="font-mono text-xs">{a.action}</TableCell>
                          <TableCell className="text-muted-foreground max-w-md truncate text-xs">{a.after ? JSON.stringify(a.after).slice(0, 140) : ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        {user.isStaff && siteForOrg ? <TabsContent value="theme" className="pt-4">{tab === "theme" ? <ThemeTab site={siteForOrg} /> : null}</TabsContent> : null}
        {user.isStaff ? <TabsContent value="deployment" className="pt-4">{tab === "deployment" ? <DeploymentTab /> : null}</TabsContent> : null}
        {user.isStaff ? <TabsContent value="staff" className="pt-4">{tab === "staff" ? <StaffTab /> : null}</TabsContent> : null}
      </UrlTabs>
    </AppShell>
  );
}
