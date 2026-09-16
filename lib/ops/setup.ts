import { createHmac } from "node:crypto";
import { promises as dns } from "node:dns";
import postgres from "postgres";
import { appDatabaseUrl, rendererDatabaseUrl, supabasePublishableKey, supabaseServiceRoleKey, supabaseUrl } from "@/lib/db/env";
import { readHeartbeats, type HeartbeatRow } from "@/lib/jobs/heartbeat";

/**
 * The setup checklist behind /ops/setup: every requirement for a working
 * deployment, checked live where it can be, with the exact fix next to each
 * failure. Written so the first operator never has to guess which dashboard
 * toggle is missing.
 */

export type CheckState = "ok" | "fail" | "warn" | "skip";
export type CheckGroup = "database" | "auth" | "app" | "edge" | "jobs" | "integrations";

export interface SetupCheck {
  key: string;
  group: CheckGroup;
  label: string;
  state: CheckState;
  detail: string;
  fix?: string;
  /** True while the page should keep polling: something was just started. */
  live?: boolean;
}

type Env = NodeJS.ProcessEnv;

function present(env: Env, ...names: string[]): string | null {
  for (const n of names) if (env[n]) return n;
  return null;
}

function envCheck(env: Env, group: CheckGroup, key: string, label: string, names: string[], opts: { fix: string; optional?: boolean }): SetupCheck {
  const found = present(env, ...names);
  if (found) return { key, group, label, state: "ok", detail: `${found} is set` };
  return { key, group, label, state: opts.optional ? "warn" : "fail", detail: `${names.join(" / ")} not set`, fix: opts.fix };
}

/** Pure: which variables are present. */
export function envChecks(env: Env = process.env): SetupCheck[] {
  return [
    envCheck(env, "database", "env.supabase_url", "Supabase URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"], { fix: "Install the Supabase integration on the Vercel project, or set NEXT_PUBLIC_SUPABASE_URL." }),
    envCheck(env, "database", "env.publishable_key", "Supabase publishable key", ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"], { fix: "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (Dashboard → Project Settings → API keys)." }),
    envCheck(env, "database", "env.service_role", "Supabase service role key", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"], { fix: "Set SUPABASE_SERVICE_ROLE_KEY (or a Supabase secret key as SUPABASE_SECRET_KEY); middleware resolves sites with it. A variable added in Vercel reaches the app only on the next deployment, and only for the environments it was added to." }),
    envCheck(env, "database", "env.database_url", "App database URL", ["DATABASE_URL", "POSTGRES_URL"], { fix: "Set DATABASE_URL to the transaction pooler URI (port 6543)." }),
    envCheck(env, "database", "env.renderer_url", "Renderer database credential", ["RENDERER_DATABASE_URL", "RENDERER_DB_PASSWORD"], { fix: "Set RENDERER_DB_PASSWORD (the `renderer` role's password) or a full RENDERER_DATABASE_URL." }),
    envCheck(env, "app", "env.app_url", "APP_URL", ["APP_URL"], { fix: "Set APP_URL to this deployment's public URL; Slack links and the Worker's telemetry endpoint use it." }),
    envCheck(env, "app", "env.staff_emails", "Staff bootstrap emails", ["AEO_STAFF_EMAILS"], { fix: "Set AEO_STAFF_EMAILS to a comma-separated list; those users get /ops on sign-in.", optional: true }),
    envCheck(env, "edge", "env.edge_domain", "AEO_EDGE_DOMAIN", ["AEO_EDGE_DOMAIN"], { fix: "Set AEO_EDGE_DOMAIN (e.g. blogedge.example.com) and add the wildcard to Vercel. See docs/EDGE_SETUP.md." }),
    envCheck(env, "edge", "env.mirror", "R2 mirror origin", ["AEO_MIRROR_ORIGIN"], { fix: "Optional until the R2 mirror ships; the Worker falls back to Cloudflare's cache without it.", optional: true }),
    envCheck(env, "jobs", "env.inngest", "Inngest keys", ["INNGEST_EVENT_KEY"], { fix: "Connect the Vercel project in the Inngest dashboard (sets INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY)." }),
    envCheck(env, "jobs", "env.llm", "Model provider key", ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"], { fix: "Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY); fact extraction, briefs and drafts are no-ops without it." }),
    envCheck(env, "integrations", "env.oauth_state", "OAuth state secret", ["OAUTH_STATE_SECRET"], { fix: "Set OAUTH_STATE_SECRET (≥16 random chars) before connecting Slack or Google." }),
    envCheck(env, "integrations", "env.slack", "Slack app", ["SLACK_CLIENT_ID"], { fix: "Create the Slack app and set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET.", optional: true }),
    envCheck(env, "integrations", "env.google", "Google OAuth client", ["GOOGLE_OAUTH_CLIENT_ID"], { fix: "Create a Google OAuth client with the Search Console and Analytics read-only scopes.", optional: true }),
    envCheck(env, "integrations", "env.serp", "SERP provider", ["DATAFORSEO_LOGIN", "SERPAPI_KEY"], { fix: "Set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD and/or SERPAPI_KEY to enable demand mining and AI Overview tracking.", optional: true }),
  ];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function appDbCheck(env: Env): Promise<SetupCheck[]> {
  const url = appDatabaseUrl(env);
  if (!url) return [{ key: "db.app", group: "database", label: "App database reachable", state: "skip", detail: "no DATABASE_URL" }];
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 5 });
  try {
    const [row] = await withTimeout(sql<{ sites: number; has_secret: boolean; has_hook: boolean }[]>`
      select (select count(*)::int from app.sites) as sites,
             exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'sites' and column_name = 'proxy_hmac_secret') as has_secret,
             exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'custom_access_token_hook') as has_hook`, 8000);
    const out: SetupCheck[] = [{ key: "db.app", group: "database", label: "App database reachable", state: "ok", detail: `${row?.sites ?? 0} site(s)` }];
    out.push(row?.has_hook
      ? { key: "db.migrations", group: "database", label: "Migrations applied", state: row.has_secret ? "ok" : "fail", detail: row.has_secret ? "0010 present" : "0009 present, 0010 missing", fix: row.has_secret ? undefined : "Apply supabase/migrations/0010_crawl_telemetry.sql." }
      : { key: "db.migrations", group: "database", label: "Migrations applied", state: "fail", detail: "0009_app_auth missing", fix: "Apply supabase/migrations/0009 and 0010." });
    return out;
  } catch (e) {
    return [{ key: "db.app", group: "database", label: "App database reachable", state: "fail", detail: msg(e), fix: "Check DATABASE_URL (pooler host, port 6543, `postgres.<ref>` user) and that the project is not paused." }];
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function rendererDbCheck(env: Env): Promise<SetupCheck[]> {
  const url = rendererDatabaseUrl(env);
  if (!url) return [{ key: "db.renderer", group: "database", label: "Renderer role", state: "skip", detail: "no renderer credential" }];
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 5 });
  try {
    const [row] = await withTimeout(sql<{ n: number }[]>`select count(*)::int as n from content.published_pages`, 8000);
    let isolation: SetupCheck;
    try {
      await sql`select 1 from app.sites limit 1`;
      isolation = { key: "db.renderer_isolation", group: "database", label: "Renderer cannot read app.sites", state: "fail", detail: "the renderer role can read app.sites", fix: "Re-run migration 0001's renderer grants; the role must have SELECT on content.published_pages and content.site_render_config only." };
    } catch {
      isolation = { key: "db.renderer_isolation", group: "database", label: "Renderer cannot read app.sites", state: "ok", detail: "insufficient_privilege, as required" };
    }
    return [{ key: "db.renderer", group: "database", label: "Renderer role connects", state: "ok", detail: `${row?.n ?? 0} published page(s)` }, isolation];
  } catch (e) {
    return [{ key: "db.renderer", group: "database", label: "Renderer role connects", state: "fail", detail: msg(e), fix: "Run `alter role renderer login password '…'` on the project and set RENDERER_DB_PASSWORD to it." }];
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function postgrestCheck(env: Env, fetchImpl: typeof fetch): Promise<SetupCheck> {
  const base = supabaseUrl(env);
  const key = supabaseServiceRoleKey(env);
  if (!base || !key) return { key: "api.app_schema", group: "database", label: "PostgREST exposes the app schema", state: "skip", detail: "Supabase URL or service key missing" };
  try {
    const res = await fetchImpl(`${base}/rest/v1/sites?select=id&limit=1`, { headers: { apikey: key, authorization: `Bearer ${key}`, "accept-profile": "app" }, cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (res.ok) return { key: "api.app_schema", group: "database", label: "PostgREST exposes the app schema", state: "ok", detail: `status ${res.status}` };
    return { key: "api.app_schema", group: "database", label: "PostgREST exposes the app schema", state: "fail", detail: `status ${res.status}`, fix: "Dashboard → Project Settings → API → Exposed schemas: add `app` and `content`. Without this every proxied request degrades to 503." };
  } catch (e) {
    return { key: "api.app_schema", group: "database", label: "PostgREST exposes the app schema", state: "fail", detail: msg(e) };
  }
}

async function edgeDnsCheck(env: Env): Promise<SetupCheck> {
  const domain = env.AEO_EDGE_DOMAIN;
  if (!domain) return { key: "edge.dns", group: "edge", label: "Edge wildcard DNS", state: "skip", detail: "no AEO_EDGE_DOMAIN" };
  const probe = `_aeo-probe.${domain}`;
  try {
    const answers = await withTimeout(dns.resolve(probe, "CNAME").catch(() => dns.resolve4(probe)), 5000);
    return { key: "edge.dns", group: "edge", label: "Edge wildcard DNS", state: "ok", detail: `${probe} → ${answers.join(", ")}` };
  } catch (e) {
    return { key: "edge.dns", group: "edge", label: "Edge wildcard DNS", state: "fail", detail: `${probe}: ${msg(e)}`, fix: `Add *.${domain} to the Vercel project's domains and a wildcard CNAME to cname.vercel-dns.com. See docs/EDGE_SETUP.md.` };
  }
}

/**
 * Sign a request the way Inngest's SDK verifies it: HMAC-SHA256 over the
 * body followed by the unix-seconds timestamp, keyed by the signing key
 * without its `signkey-<env>-` prefix. A GET carries no body and the SDK
 * (inngest 4.x, InngestCommHandler.handleAsyncRequest) hashes the empty
 * string for it, so this does too.
 */
export function inngestSignature(signingKey: string, body: string | undefined, nowMs = Date.now()): string {
  const ts = Math.round(nowMs / 1000).toString();
  const key = signingKey.replace(/^signkey-[\w]+-/, "");
  const data = typeof body === "string" ? body : "";
  return `t=${ts}&s=${createHmac("sha256", key).update(data + ts).digest("hex")}`;
}

/**
 * Can Inngest reach us? It registers and invokes every function through
 * GET/PUT/POST on /api/inngest, so the endpoint must answer the SDK's own
 * JSON. Vercel Deployment Protection answers a redirect to vercel.com/sso-api
 * instead, which is the single most common reason "Queued" never turns into
 * a run. In cloud mode the SDK only answers a signed request, so the check
 * signs with the deployment's own key; a 401 that the SDK itself sent means
 * the handler is live but the key it runs with is not the one we signed with.
 */
export async function jobsEndpointCheck(env: Env, fetchImpl: typeof fetch): Promise<SetupCheck> {
  const key = "jobs.endpoint";
  const label = "Inngest can reach /api/inngest";
  const base = env.APP_URL?.replace(/\/+$/, "");
  if (!base) return { key, group: "jobs", label, state: "skip", detail: "APP_URL unset" };
  const url = `${base}/api/inngest`;
  const protectionFix = "Vercel → Project → Settings → Deployment Protection → Vercel Authentication: choose \"Only Preview Deployments\" (or add a Protection Bypass for Automation secret to the Inngest integration). Then sync the app in the Inngest dashboard.";
  const signingKey = env.INNGEST_SIGNING_KEY;
  const headers: Record<string, string> = { accept: "application/json" };
  if (signingKey) headers["x-inngest-signature"] = inngestSignature(signingKey, undefined);
  try {
    const res = await fetchImpl(url, { headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(6000) });
    const location = res.headers.get("location") ?? "";
    if (res.status >= 300 && res.status < 400) {
      const sso = /vercel\.com\/sso-api/.test(location);
      return { key, group: "jobs", label, state: "fail", detail: `${url} redirects to ${sso ? "Vercel SSO" : location || "another URL"}`, fix: sso ? protectionFix : "The endpoint must answer directly; check rewrites and APP_URL." };
    }
    if (res.status === 401 || res.status === 403) {
      const sdk = res.headers.get("x-inngest-sdk-handled") === "true";
      if (!sdk) return { key, group: "jobs", label, state: "fail", detail: `${url} answered ${res.status} before reaching the Inngest handler`, fix: protectionFix };
      if (!signingKey) return { key, group: "jobs", label, state: "fail", detail: `${url} is served by the Inngest handler, but INNGEST_SIGNING_KEY is not set on this deployment so nothing can authenticate to it`, fix: "Install the Inngest Vercel integration (it sets INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY) or copy the signing key from Inngest → Manage → Signing key, then redeploy." };
      return { key, group: "jobs", label, state: "warn", detail: `${url} is served by the Inngest handler in cloud mode, but it rejected this check's signed request`, fix: "The INNGEST_SIGNING_KEY this deployment runs with may not be Inngest's current signing key: compare Inngest → Manage → Signing key with the Vercel environment variable and redeploy. The Inngest dashboard's Apps page shows whether this app is synced either way." };
    }
    if (!res.ok) return { key, group: "jobs", label, state: "fail", detail: `${url} answered ${res.status}`, fix: "The Inngest serve route is failing; check the runtime logs for /api/inngest." };
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!body || typeof body.function_count !== "number") return { key, group: "jobs", label, state: "fail", detail: `${url} answered ${res.status} without Inngest's introspection JSON`, fix: "Something other than the Inngest handler is answering this path; check middleware and rewrites." };
    const mode = typeof body.mode === "string" ? body.mode : "unknown";
    if (body.has_signing_key === false || body.has_event_key === false) return { key, group: "jobs", label, state: "fail", detail: `${body.function_count} functions, mode ${mode}, keys missing at runtime`, fix: "Redeploy after the Inngest integration set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY; the running build was made before they existed." };
    return { key, group: "jobs", label, state: "ok", detail: `${body.function_count} functions registered, mode ${mode}` };
  } catch (e) {
    return { key, group: "jobs", label, state: "fail", detail: `${url}: ${msg(e)}`, fix: "APP_URL must be this deployment's public URL and reachable from the internet." };
  }
}

/** The scheduler beats every five minutes; three missed beats is stopped, not late. */
export const CRON_BEAT_MS = 5 * 60 * 1000;
export const CRON_STALE_AFTER_MS = 3 * CRON_BEAT_MS;
/** A test event Inngest has not delivered after this long is lost, not queued. */
export const PING_GRACE_MS = 2 * 60 * 1000;

const ago = (from: Date, to: Date): string => {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

const dashboardFix = (env: Env) => {
  const url = `${(env.APP_URL ?? "https://<APP_URL>").replace(/\/+$/, "")}/api/inngest`;
  return `In the Inngest dashboard: Apps → aeo-platform must be synced at ${url} with no sync error: a red "Error" on the app card (for example a function whose concurrency limit exceeds the plan's) means Inngest rejected the whole app and runs nothing; re-sync it from there once the cause is fixed or if the URL or the function list is stale; Functions → site-health-monitor → Runs should show a run every 5 minutes; a paused environment or an exhausted plan shows a banner. INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY must both belong to that same Inngest environment; the Vercel integration sets a matching pair.`;
};

/**
 * Pure: does the runner execute functions here? The endpoint check above
 * proves Inngest can call us; only a heartbeat row proves it does. Both
 * checks are skipped when there is no database to read them from, and warn
 * when the table predates the migration that created it.
 */
export function jobsHeartbeatChecks(rows: HeartbeatRow[] | null, now: Date, env: Env = process.env): SetupCheck[] {
  const cronKey = "jobs.cron";
  const pingKey = "jobs.ping";
  if (rows === null) {
    return [{ key: cronKey, group: "jobs", label: "Inngest runs functions here", state: "warn", detail: "ops.job_heartbeats does not exist yet", fix: "Apply supabase/migrations/0017_job_heartbeats.sql; the scheduler heartbeat and the test event both record into it." }];
  }
  const by = new Map(rows.map((r) => [r.key, r]));
  const out: SetupCheck[] = [];

  const cron = by.get("cron");
  if (!cron) {
    out.push({ key: cronKey, group: "jobs", label: "Inngest runs functions here", state: "fail", detail: "no scheduled function has ever run against this database", fix: `Inngest can reach /api/inngest (see above) but has not executed a function here. ${dashboardFix(env)}` });
  } else {
    const at = new Date(cron.seen_at);
    const age = now.getTime() - at.getTime();
    if (age <= CRON_STALE_AFTER_MS) out.push({ key: cronKey, group: "jobs", label: "Inngest runs functions here", state: "ok", detail: `last scheduled run ${ago(at, now)} (site-health-monitor, every 5 minutes${cron.deployment ? `, deployment ${cron.deployment}` : ""})` });
    else out.push({ key: cronKey, group: "jobs", label: "Inngest runs functions here", state: "fail", detail: `last scheduled run ${ago(at, now)}; nothing since, though one is due every 5 minutes`, fix: `The scheduler stopped invoking this app. ${dashboardFix(env)}` });
  }

  const sent = by.get("ping:sent");
  const received = by.get("ping:received");
  if (!sent) {
    out.push({ key: pingKey, group: "jobs", label: "Test event round trip", state: "skip", detail: "not sent yet: use \"Send a test event\" to prove the event key, the sync and a function run end to end" });
    return out;
  }
  const sentAt = new Date(sent.seen_at);
  const sentAgo = ago(sentAt, now);
  const error = typeof sent.detail?.error === "string" ? sent.detail.error : null;
  if (error) {
    out.push({ key: pingKey, group: "jobs", label: "Test event round trip", state: "fail", detail: `sent ${sentAgo}, refused: ${error}`, fix: "Inngest did not accept the event. INNGEST_EVENT_KEY is wrong, revoked, or belongs to another environment; copy the event key from Inngest → Manage → Event keys (or reinstall the Vercel integration) and redeploy." });
    return out;
  }
  const matched = received && received.detail?.nonce === sent.detail?.nonce && new Date(received.seen_at).getTime() >= sentAt.getTime();
  if (matched) {
    const ms = new Date(received.seen_at).getTime() - sentAt.getTime();
    out.push({ key: pingKey, group: "jobs", label: "Test event round trip", state: "ok", detail: `received ${ms < 1000 ? "under a second" : `${Math.round(ms / 1000)}s`} after it was sent (${sentAgo})` });
    return out;
  }
  const waiting = now.getTime() - sentAt.getTime() < PING_GRACE_MS;
  if (waiting) out.push({ key: pingKey, group: "jobs", label: "Test event round trip", state: "warn", detail: `sent ${sentAgo}; waiting for the ops-ping function to run`, live: true });
  else out.push({ key: pingKey, group: "jobs", label: "Test event round trip", state: "fail", detail: `sent ${sentAgo} and accepted by Inngest, but no function ran for it`, fix: `The event reached Inngest (the send succeeded) and nothing executed: the app synced under a different Inngest environment than INNGEST_EVENT_KEY belongs to, the sync is stale or failed, or the environment is paused. Inngest → Events should list ops/ping.requested at that time with a run beneath it. ${dashboardFix(env)}` });
  return out;
}

async function heartbeatRows(env: Env): Promise<HeartbeatRow[] | null | undefined> {
  const url = appDatabaseUrl(env);
  if (!url) return undefined;
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 5 });
  try {
    return await withTimeout(readHeartbeats(sql), 8000);
  } catch {
    return undefined;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

/** Decoded JWT payload, or null. No verification: this is our own session's token, read for its claims. */
export function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function authHookCheck(claims: Record<string, unknown> | null, env: Env = process.env): SetupCheck {
  if (!supabaseUrl(env) || !supabasePublishableKey(env)) return { key: "auth.hook", group: "auth", label: "Access token hook", state: "skip", detail: "auth not configured" };
  if (!claims) return { key: "auth.hook", group: "auth", label: "Access token hook", state: "warn", detail: "no session token to inspect" };
  if (Array.isArray(claims.org_ids) && typeof claims.is_staff === "boolean") return { key: "auth.hook", group: "auth", label: "Access token hook", state: "ok", detail: `org_ids (${claims.org_ids.length}) and is_staff present` };
  return { key: "auth.hook", group: "auth", label: "Access token hook", state: "fail", detail: "org_ids / is_staff claims missing from the session token", fix: "Dashboard → Authentication → Hooks → Customize Access Token: enable and select `app.custom_access_token_hook`, then sign out and back in." };
}

export function authUrlCheck(env: Env = process.env): SetupCheck {
  const app = env.APP_URL;
  if (!app) return { key: "auth.redirect", group: "auth", label: "Auth redirect URL", state: "warn", detail: "APP_URL unset, cannot state the callback", fix: "Set APP_URL, then add `${APP_URL}/auth/callback` under Authentication → URL Configuration → Redirect URLs." };
  return { key: "auth.redirect", group: "auth", label: "Auth redirect URL", state: "warn", detail: `must include ${app}/auth/callback (not verifiable from here)`, fix: `Authentication → URL Configuration: Site URL ${app}, Redirect URLs + ${app}/auth/callback.` };
}

export interface SetupReport {
  checks: SetupCheck[];
  failing: number;
  warnings: number;
}

export async function runSetupChecks(opts: { env?: Env; claims?: Record<string, unknown> | null; fetchImpl?: typeof fetch; now?: Date } = {}): Promise<SetupReport> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const [app, renderer, rest, edge, jobs, beats] = await Promise.all([appDbCheck(env), rendererDbCheck(env), postgrestCheck(env, fetchImpl), edgeDnsCheck(env), jobsEndpointCheck(env, fetchImpl), heartbeatRows(env)]);
  const heartbeat = beats === undefined ? [] : jobsHeartbeatChecks(beats, now, env);
  const checks = [...envChecks(env), ...app, ...renderer, rest, authUrlCheck(env), authHookCheck(opts.claims ?? null, env), edge, jobs, ...heartbeat];
  return { checks, failing: checks.filter((c) => c.state === "fail").length, warnings: checks.filter((c) => c.state === "warn").length };
}
