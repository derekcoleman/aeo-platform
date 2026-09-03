import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { appDb } from "@/lib/db/app";
import { EDGE_DOMAIN_SUFFIX, normaliseHost, normalisePathPrefix, type ProxyMode } from "@/lib/tenancy";

/**
 * Organisations and sites ("projects" in the UI) for the app plane. Runs on
 * the service connection AFTER lib/auth/session has checked the caller, so
 * every write takes the user id explicitly and every read is scoped by the
 * org ids the caller may see.
 */

// ── pure helpers ────────────────────────────────────────────────────────────

export function slugify(name: string, max = 48): string {
  const s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return s || "org";
}

/** `{slug}-{8 hex}.blogedge.aeo.app` — non-guessable, cache-key-safe, and never shown to visitors. */
export function edgeHostnameFor(name: string, random: () => string = () => randomBytes(4).toString("hex")): string {
  return `${slugify(name, 24)}-${random()}.${EDGE_DOMAIN_SUFFIX}`;
}

/** A bare domain: no scheme, no path, no port; www. stripped so acme.com and www.acme.com are one site. */
export function canonicalDomainOf(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!.replace(/\.$/, "");
  const host = raw.replace(/^www\./, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null;
  return normaliseHost(host);
}

export const proxyModes: ProxyMode[] = ["cloudflare_worker", "vercel_rewrite", "nginx", "netlify", "subdomain"];

export const createOrgSchema = z.object({ name: z.string().trim().min(2).max(80) });

export const createSiteSchema = z.object({
  orgId: z.guid(),
  name: z.string().trim().min(2).max(80),
  domain: z.string().trim().min(3).max(253),
  pathPrefix: z.string().trim().default("/resources"),
  proxyMode: z.enum(["cloudflare_worker", "vercel_rewrite", "nginx", "netlify", "subdomain"]).default("cloudflare_worker"),
  organizationName: z.string().trim().max(120).optional(),
});
export type CreateSiteInput = z.infer<typeof createSiteSchema>;

// ── organisations ───────────────────────────────────────────────────────────

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string | Date;
}

/** Create an org and make the caller its owner. The slug gets a suffix on collision rather than failing. */
export async function createOrganization(userId: string, name: string, sql: postgres.Sql = appDb()): Promise<OrgRow> {
  const base = slugify(name);
  return sql.begin(async (tx) => {
    const taken = await tx<{ slug: string }[]>`select slug from app.organizations where slug = ${base} or slug like ${`${base}-%`}`;
    const set = new Set(taken.map((t) => t.slug));
    let slug = base;
    for (let n = 2; set.has(slug); n++) slug = `${base}-${n}`;
    const [org] = await tx<OrgRow[]>`
      insert into app.organizations (name, slug) values (${name.trim()}, ${slug})
      returning id, name, slug, plan, status, created_at`;
    if (!org) throw new Error("organization insert returned no row");
    await tx`insert into app.memberships (user_id, org_id, role) values (${userId}, ${org.id}, 'owner')`;
    await tx`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
             values (${org.id}, ${userId}, 'org.create', 'organization', ${org.id}, ${tx.json({ name: org.name, slug } as never)})`;
    return org;
  });
}

export async function listOrganizations(orgIds: string[] | "all", sql: postgres.Sql = appDb()): Promise<OrgRow[]> {
  if (orgIds !== "all" && orgIds.length === 0) return [];
  return orgIds === "all"
    ? sql<OrgRow[]>`select id, name, slug, plan, status, created_at from app.organizations order by created_at desc`
    : sql<OrgRow[]>`select id, name, slug, plan, status, created_at from app.organizations where id = any(${sql.array(orgIds)}::uuid[]) order by name`;
}

// ── sites ───────────────────────────────────────────────────────────────────

export interface SiteRow {
  id: string;
  org_id: string;
  name: string;
  canonical_domain: string;
  path_prefix: string;
  edge_hostname: string;
  proxy_mode: ProxyMode;
  trailing_slash: "never" | "always";
  locale: string;
  status: "provisioning" | "verifying" | "active" | "paused" | "disabled";
  verified_at: string | Date | null;
  health_failures: number;
  last_health_ok: boolean | null;
  last_health_at: string | Date | null;
  created_at: string | Date;
}


export class SiteInputError extends Error {}

/**
 * Create a site: canonical + www domains registered, a fresh edge hostname,
 * the render config materialised by trigger, and the organisation name
 * seeded into content.site_render_config for JSON-LD.
 */
export async function createSite(userId: string, input: CreateSiteInput, sql: postgres.Sql = appDb(), random?: () => string): Promise<SiteRow> {
  const domain = canonicalDomainOf(input.domain);
  if (!domain) throw new SiteInputError("Enter a bare domain such as acme.com");
  const pathPrefix = normalisePathPrefix(input.pathPrefix || "/resources");
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/.test(pathPrefix) || pathPrefix.endsWith("/") || pathPrefix === "/render" || pathPrefix.startsWith("/render/")) {
    throw new SiteInputError("The path prefix must look like /resources (lowercase, no trailing slash, not /render)");
  }
  return sql.begin(async (tx) => {
    const [dup] = await tx<{ id: string }[]>`select id from app.sites where org_id = ${input.orgId} and canonical_domain = ${domain} and path_prefix = ${pathPrefix}`;
    if (dup) throw new SiteInputError(`${domain}${pathPrefix} already exists in this organisation`);
    let site: SiteRow | undefined;
    for (let attempt = 0; attempt < 3 && !site; attempt++) {
      const edge = edgeHostnameFor(input.name, random);
      const rows = await tx<SiteRow[]>`
        insert into app.sites (org_id, name, canonical_domain, path_prefix, edge_hostname, proxy_mode)
        values (${input.orgId}, ${input.name.trim()}, ${domain}, ${pathPrefix}, ${edge}, ${input.proxyMode})
        on conflict (edge_hostname) do nothing
        returning id, org_id, name, canonical_domain, path_prefix, edge_hostname, proxy_mode, trailing_slash, locale, status, verified_at, health_failures, last_health_ok, last_health_at, created_at`;
      site = rows[0];
    }
    if (!site) throw new Error("could not allocate an edge hostname");
    await tx`insert into app.site_domains (org_id, site_id, hostname, is_primary) values (${input.orgId}, ${site.id}, ${domain}, true), (${input.orgId}, ${site.id}, ${`www.${domain}`}, false) on conflict do nothing`;
    await tx`update content.site_render_config set organization = ${tx.json({ name: input.organizationName?.trim() || input.name.trim(), url: `https://${domain}` } as never)} where site_id = ${site.id}`;
    await tx`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
             values (${input.orgId}, ${userId}, 'site.create', 'site', ${site.id}, ${tx.json({ domain, pathPrefix, proxyMode: input.proxyMode } as never)})`;
    return site;
  });
}

export async function listSites(orgIds: string[] | "all", sql: postgres.Sql = appDb()): Promise<SiteRow[]> {
  if (orgIds !== "all" && orgIds.length === 0) return [];
  return orgIds === "all"
    ? sql<SiteRow[]>`select id, org_id, name, canonical_domain, path_prefix, edge_hostname, proxy_mode, trailing_slash, locale, status, verified_at, health_failures, last_health_ok, last_health_at, created_at from app.sites order by created_at desc`
    : sql<SiteRow[]>`select id, org_id, name, canonical_domain, path_prefix, edge_hostname, proxy_mode, trailing_slash, locale, status, verified_at, health_failures, last_health_ok, last_health_at, created_at from app.sites where org_id = any(${sql.array(orgIds)}::uuid[]) order by created_at desc`;
}

export async function loadSite(siteId: string, sql: postgres.Sql = appDb()): Promise<SiteRow | null> {
  const [row] = await sql<SiteRow[]>`select id, org_id, name, canonical_domain, path_prefix, edge_hostname, proxy_mode, trailing_slash, locale, status, verified_at, health_failures, last_health_ok, last_health_at, created_at from app.sites where id = ${siteId}`;
  return row ?? null;
}

export async function setSiteStatus(siteId: string, orgId: string, status: "paused" | "active" | "disabled", userId: string, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update app.sites set status = ${status} where id = ${siteId} and org_id = ${orgId}`;
  await sql`insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after) values (${orgId}, ${userId}, 'site.status', 'site', ${siteId}, ${sql.json({ status } as never)})`;
}
