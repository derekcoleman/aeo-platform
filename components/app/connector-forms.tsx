"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/app/actions";
import { configureGoogleAction, configureSlackAction, connectCustomAction } from "@/lib/app/connector-actions";
import { ProfoundConnectForm } from "@/components/app/strategy-forms";
import { WebflowConnectForm } from "@/components/app/publishing-forms";

/**
 * The interactive halves of the Connectors page. Each form posts to one
 * server action and shows its outcome inline; the page around them is a
 * server component that supplies the option lists.
 */

const selectClass = "border-input bg-background h-9 rounded-md border px-3 text-sm";

export interface SiteOption {
  id: string;
  name: string;
  domain: string;
}

function Note({ state, okText = "Saved" }: { state: ActionResult | null; okText?: string }) {
  if (!state) return null;
  if (!state.ok) return <span className="text-destructive text-xs">{state.error}</span>;
  return <span className="text-muted-foreground text-xs">{state.note ?? state.error ?? okText}</span>;
}

function SiteSelect({ sites, value, onChange, name, allowNone = false }: { sites: SiteOption[]; value: string; onChange: (v: string) => void; name?: string; allowNone?: boolean }) {
  return (
    <select name={name} className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone ? <option value="">Whole organisation</option> : null}
      {sites.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.domain}</option>)}
    </select>
  );
}

/** Start an OAuth flow for a project (Google) or the organisation (Slack). */
export function OAuthConnect({ provider, orgId, sites, label, ready, siteScoped }: { provider: "google" | "slack"; orgId: string; sites: SiteOption[]; label: string; ready: boolean; siteScoped: boolean }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const href = `/api/connectors/${provider}/start?orgId=${encodeURIComponent(orgId)}${siteScoped && siteId ? `&siteId=${encodeURIComponent(siteId)}` : ""}&returnTo=${encodeURIComponent("/settings/connectors")}`;
  if (!ready) return <p className="text-muted-foreground text-xs">This deployment has no {provider === "google" ? "Google" : "Slack"} OAuth client configured ({provider === "google" ? "GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI" : "SLACK_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI"}). Ops → Setup lists what is missing.</p>;
  if (siteScoped && sites.length === 0) return <p className="text-muted-foreground text-xs">Create a project first; this connector binds to one.</p>;
  return (
    <div className="flex flex-wrap items-end gap-3">
      {siteScoped ? (
        <div className="grid gap-1">
          <Label>Project</Label>
          <SiteSelect sites={sites} value={siteId} onChange={setSiteId} />
        </div>
      ) : null}
      <Button asChild><a href={href}>{label}</a></Button>
    </div>
  );
}

/** Pick the Search Console property and / or the GA4 property for a Google grant. */
export function GoogleConfigForm({ connectionId, focus, gsc, ga4, current, lookupError }: { connectionId: string; focus: "gsc" | "ga4"; gsc: { siteUrl: string; permissionLevel: string }[]; ga4: { propertyId: string; displayName: string }[]; current: { gscProperty: string | null; ga4PropertyId: string | null }; lookupError: string | null }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(configureGoogleAction, null);
  const other = focus === "gsc" ? current.ga4PropertyId : current.gscProperty;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      {/* The grant is one row; keep the other product's choice when saving this one. */}
      {focus === "gsc" ? <input type="hidden" name="ga4PropertyId" value={other ?? ""} /> : <input type="hidden" name="gscProperty" value={other ?? ""} />}
      {lookupError ? <p className="text-destructive text-xs">Could not list properties: {lookupError}</p> : null}
      {focus === "gsc" ? (
        <div className="grid gap-1">
          <Label>Search Console property</Label>
          <select name="gscProperty" className={selectClass} defaultValue={current.gscProperty ?? ""}>
            <option value="">— not selected —</option>
            {gsc.map((p) => <option key={p.siteUrl} value={p.siteUrl}>{p.siteUrl} ({p.permissionLevel.replace("site", "")})</option>)}
            {current.gscProperty && !gsc.some((p) => p.siteUrl === current.gscProperty) ? <option value={current.gscProperty}>{current.gscProperty}</option> : null}
          </select>
          {gsc.length === 0 && !lookupError ? <p className="text-muted-foreground text-xs">The granting account can read no Search Console properties. Add it as a user on the property, then reconnect.</p> : null}
        </div>
      ) : (
        <div className="grid gap-1">
          <Label>GA4 property</Label>
          <select name="ga4PropertyId" className={selectClass} defaultValue={current.ga4PropertyId ?? ""}>
            <option value="">— not selected —</option>
            {ga4.map((p) => <option key={p.propertyId} value={p.propertyId}>{p.displayName} ({p.propertyId})</option>)}
            {current.ga4PropertyId && !ga4.some((p) => p.propertyId === current.ga4PropertyId) ? <option value={current.ga4PropertyId}>{current.ga4PropertyId}</option> : null}
          </select>
          {ga4.length === 0 && !lookupError ? <p className="text-muted-foreground text-xs">The granting account can read no GA4 properties, or the Analytics Admin API is not enabled on the OAuth project.</p> : null}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Note state={state} />
      </div>
    </form>
  );
}

/** Choose which channels Slack reads, and where approvals and alerts post. */
export function SlackChannelsForm({ connectionId, channels, selected, approvalsChannel, alertsChannel, lookupError }: { connectionId: string; channels: { id: string; name: string; is_private?: boolean; is_member?: boolean }[]; selected: string[]; approvalsChannel: string | null; alertsChannel: string | null; lookupError: string | null }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(configureSlackAction, null);
  const [filter, setFilter] = useState("");
  const shown = channels.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      {lookupError ? <p className="text-destructive text-xs">Could not list channels: {lookupError}</p> : null}
      <div className="grid gap-1">
        <Label>Channels to read into the brand brain (nothing by default)</Label>
        {channels.length > 12 ? <Input placeholder="Filter channels" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" /> : null}
        <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2 text-sm sm:grid-cols-2">
          {shown.length === 0 ? <p className="text-muted-foreground text-xs">No channels visible to the app.</p> : null}
          {shown.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input type="checkbox" name="channels" value={c.id} defaultChecked={selected.includes(c.id)} />
              <input type="hidden" name={`name:${c.id}`} value={c.name} />
              <span>#{c.name}</span>
              {c.is_private ? <span className="text-muted-foreground text-xs">private{c.is_member ? "" : " · invite the app"}</span> : null}
            </label>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label>Approvals channel (brief / draft decisions with one-click buttons)</Label>
          <select name="approvalsChannel" className={selectClass} defaultValue={approvalsChannel ?? ""}>
            <option value="">— keep approvals in the app —</option>
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>
        <div className="grid gap-1">
          <Label>Alerts channel (proxy health)</Label>
          <select name="alertsChannel" className={selectClass} defaultValue={alertsChannel ?? ""}>
            <option value="">— no alerts —</option>
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save channels"}</Button>
        <Note state={state} />
      </div>
    </form>
  );
}

/** Profound and Webflow connect per project; this wraps their forms with a project picker. */
export function SiteScopedConnect({ kind, sites }: { kind: "profound" | "webflow"; sites: SiteOption[] }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  if (sites.length === 0) return <p className="text-muted-foreground text-xs">Create a project first; this connector binds to one.</p>;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label>Project</Label>
        <SiteSelect sites={sites} value={siteId} onChange={setSiteId} />
      </div>
      {kind === "profound" ? <ProfoundConnectForm key={siteId} siteId={siteId} /> : <WebflowConnectForm key={siteId} siteId={siteId} />}
    </div>
  );
}

/** A custom source: an HTTP API returning JSON or text, or an MCP server. */
export function CustomConnectorForm({ orgId, sites }: { orgId: string; sites: SiteOption[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(connectCustomAction, null);
  const [kind, setKind] = useState<"api" | "mcp">("api");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("none");
  const [siteId, setSiteId] = useState("");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="orgId" value={orgId} />
      <div className="grid gap-1">
        <Label htmlFor="custom-name">Name</Label>
        <Input id="custom-name" name="name" required maxLength={100} placeholder="Help center articles" />
      </div>
      <div className="grid gap-1">
        <Label>Applies to</Label>
        <SiteSelect name="siteId" sites={sites} value={siteId} onChange={setSiteId} allowNone />
      </div>
      <div className="grid gap-1">
        <Label>Type</Label>
        <select name="kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as "api" | "mcp")}>
          <option value="api">HTTP API (JSON records, or a page of text / Markdown)</option>
          <option value="mcp">MCP server (Streamable HTTP; resources are read)</option>
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="custom-url">{kind === "mcp" ? "MCP endpoint URL" : "Endpoint URL"}</Label>
        <Input id="custom-url" name="url" type="url" required placeholder={kind === "mcp" ? "https://mcp.example.com/mcp" : "https://api.example.com/v1/articles"} />
      </div>
      <div className="grid gap-1">
        <Label>Authentication</Label>
        <select name="authType" className={selectClass} value={authType} onChange={(e) => setAuthType(e.target.value as "none" | "bearer" | "header")}>
          <option value="none">None (public)</option>
          <option value="bearer">Bearer token (Authorization header)</option>
          <option value="header">API key in a custom header</option>
        </select>
      </div>
      {authType !== "none" ? (
        <div className="grid gap-1">
          <Label htmlFor="custom-secret">{authType === "header" ? "API key" : "Token"}</Label>
          <Input id="custom-secret" name="secret" type="password" autoComplete="off" required />
          {authType === "header" ? <Input name="headerName" placeholder="Header name (default X-API-Key)" maxLength={100} /> : null}
        </div>
      ) : <div />}
      {kind === "api" ? (
        <details className="sm:col-span-2">
          <summary className="text-muted-foreground cursor-pointer text-sm">Field mapping (optional; common names are detected automatically)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-5">
            <div className="grid gap-1"><Label>Items path</Label><Input name="itemsPath" placeholder="data.items" /></div>
            <div className="grid gap-1"><Label>Id field</Label><Input name="fieldId" placeholder="id" /></div>
            <div className="grid gap-1"><Label>Title field</Label><Input name="fieldTitle" placeholder="title" /></div>
            <div className="grid gap-1"><Label>Text field</Label><Input name="fieldText" placeholder="body" /></div>
            <div className="grid gap-1"><Label>Updated-at field</Label><Input name="fieldUpdatedAt" placeholder="updated_at" /></div>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">Dot paths, e.g. <code>attributes.body</code>. A response that is not JSON (Markdown, HTML, plain text) becomes one document.</p>
        </details>
      ) : (
        <div className="grid gap-1 sm:col-span-2">
          <Label>Only resources whose URI starts with (optional)</Label>
          <Input name="resourceFilter" placeholder="docs://" />
        </div>
      )}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Testing…" : "Test and connect"}</Button>
        <Note state={state} okText="Connected." />
      </div>
    </form>
  );
}
