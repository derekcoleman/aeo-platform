import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/app/action-button";
import { InviteForm, SettingsForm } from "@/components/app/org-forms";
import { AppShell, PageHeader } from "@/components/app/shell";
import { when } from "@/components/app/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { auditLog, listInvites, listMembers, loadOrg } from "@/lib/app/org";
import { openPortalAction, removeMemberAction, revokeInviteAction, setMemberRoleAction, startCheckoutAction } from "@/lib/app/org-actions";
import { requireUser, roleIn } from "@/lib/auth/session";
import { PLANS, stripeConfigured } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function OrgPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const { orgId } = await params;
  const { checkout } = await searchParams;
  const user = await requireUser(`/app/orgs/${orgId}`);
  const role = roleIn(user, orgId);
  if (!role) notFound();
  const [org, members, invites, audit] = await Promise.all([loadOrg(orgId), listMembers(orgId), listInvites(orgId), auditLog(orgId, 50)]);
  if (!org) notFound();
  const isOwner = role === "owner" || user.isStaff;
  const isAdmin = isOwner || role === "admin";
  const billingOn = stripeConfigured();
  return (
    <AppShell user={user} active="projects">
      <PageHeader title={org.name} description={`Organisation settings · ${org.plan} (${org.plan_status})`}>
        <Badge variant={org.plan_status === "active" ? "success" : org.plan_status === "past_due" ? "destructive" : "secondary"}>{org.plan_status}</Badge>
        <Badge variant="secondary">{members.length} members</Badge>
        <Button asChild variant="outline" size="sm"><Link href={"/app" as Route}>Projects</Link></Button>
      </PageHeader>
      {checkout === "success" ? <Alert variant="success" className="mb-4"><AlertTitle>Thanks</AlertTitle><AlertDescription>Your subscription is being confirmed; the plan updates as soon as Stripe notifies us.</AlertDescription></Alert> : null}
      {checkout === "cancel" ? <Alert className="mb-4"><AlertTitle>Checkout cancelled</AlertTitle><AlertDescription>No changes were made.</AlertDescription></Alert> : null}

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="grid gap-4 pt-4">
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
        </TabsContent>

        <TabsContent value="billing" className="grid gap-4 pt-4">
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
        </TabsContent>

        <TabsContent value="settings" className="grid gap-4 pt-4">
          <Card>
            <CardHeader><CardTitle>Settings</CardTitle><CardDescription>Owners only. Every change is audited.</CardDescription></CardHeader>
            <CardContent>{isOwner ? <SettingsForm org={org} isStaff={user.isStaff} /> : <p className="text-muted-foreground text-sm">Ask an owner to change organisation settings.</p>}</CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="pt-4">
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
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
