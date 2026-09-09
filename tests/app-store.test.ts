import { describe, expect, it } from "vitest";
import { canonicalDomainOf, createOrganization, createSite, edgeHostnameFor, SiteInputError, slugify } from "@/lib/app/store";
import { canEdit, canManage, roleIn, staffEmails, visibleOrgIds } from "@/lib/auth/roles";
import { fakeSql } from "./helpers/fake-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "99999999-0000-0000-0000-000000000001";

describe("pure helpers", () => {
  it("slugify is bounded kebab-case with a fallback", () => {
    expect(slugify("Acme, Inc.")).toBe("acme-inc");
    expect(slugify("Résumé Café")).toBe("resume-cafe");
    expect(slugify("!!!")).toBe("org");
    expect(slugify("x".repeat(100)).length).toBe(48);
  });

  it("edgeHostnameFor is slug + random + the edge suffix, never guessable from the name alone", () => {
    expect(edgeHostnameFor("Acme Resources", () => "8fj2a1b3")).toBe("acme-resources-8fj2a1b3.blogedge.aeo.app");
    expect(edgeHostnameFor("Acme")).not.toBe(edgeHostnameFor("Acme"));
  });

  it("canonicalDomainOf strips scheme, path, port and www, and rejects non-domains", () => {
    expect(canonicalDomainOf("https://www.Acme.com/resources")).toBe("acme.com");
    expect(canonicalDomainOf("acme.co.uk:443")).toBe("acme.co.uk");
    expect(canonicalDomainOf("localhost")).toBeNull();
    expect(canonicalDomainOf("not a domain")).toBeNull();
    expect(canonicalDomainOf("192.168.0.1")).toBeNull();
  });

  it("roles: members by membership, staff as admin everywhere, viewers cannot edit", () => {
    const user = { isStaff: false, memberships: [{ orgId: ORG, orgName: "Acme", orgSlug: "acme", role: "viewer" as const }] };
    expect(roleIn(user, ORG)).toBe("viewer");
    expect(canEdit(user, ORG)).toBe(false);
    expect(canManage(user, ORG)).toBe(false);
    expect(roleIn(user, "other")).toBeNull();
    const staff = { isStaff: true, memberships: [] };
    expect(roleIn(staff, "other")).toBe("admin");
    expect(canManage(staff, "other")).toBe(true);
    expect(visibleOrgIds(staff)).toBe("all");
    expect(visibleOrgIds(user)).toEqual([ORG]);
    expect(staffEmails({ AEO_STAFF_EMAILS: " Derek@Example.com, ops@aeo.app ,, " } as unknown as NodeJS.ProcessEnv)).toEqual(new Set(["derek@example.com", "ops@aeo.app"]));
  });
});

describe("createOrganization", () => {
  it("suffixes the slug on collision, makes the caller owner, and audits", async () => {
    const sql = fakeSql([
      [/select slug from app\.organizations/, () => [{ slug: "acme" }, { slug: "acme-2" }]],
      [/insert into app\.organizations/, (q) => [{ id: "o1", name: q.values[0], slug: q.values[1], plan: "trial", status: "active", created_at: "now" }]],
    ]);
    const org = await createOrganization(USER, " Acme ", sql);
    expect(org.slug).toBe("acme-3");
    expect(org.name).toBe("Acme");
    const membership = sql.queries.find((q) => q.text.startsWith("insert into app.memberships"))!;
    expect(membership.values).toEqual([USER, "o1"]);
    expect(membership.text).toContain("'owner'");
    expect(sql.queries.some((q) => q.text.startsWith("insert into app.audit_log") && q.text.includes("'org.create'"))).toBe(true);
  });
});

describe("createSite", () => {
  const input = { orgId: ORG, name: "Acme resources", domain: "https://www.acme.com/", pathPrefix: "resources/", proxyMode: "cloudflare_worker" as const };

  it("normalises domain and prefix, allocates an edge hostname, registers both domains and seeds the render config", async () => {
    const sql = fakeSql([
      [/insert into app\.sites/, (q) => [{ id: "s1", org_id: ORG, name: q.values[1], canonical_domain: q.values[2], path_prefix: q.values[3], edge_hostname: q.values[4], proxy_mode: q.values[5], trailing_slash: "never", locale: "en-US", status: "provisioning", verified_at: null, health_failures: 0, last_health_ok: null, last_health_at: null, created_at: "now" }]],
    ]);
    const site = await createSite(USER, input, sql, () => "abcd1234");
    expect(site.canonical_domain).toBe("acme.com");
    expect(site.path_prefix).toBe("/resources");
    expect(site.edge_hostname).toBe("acme-resources-abcd1234.blogedge.aeo.app");
    const domains = sql.queries.find((q) => q.text.startsWith("insert into app.site_domains"))!;
    expect(domains.values).toEqual([ORG, "s1", "acme.com", ORG, "s1", "www.acme.com"]);
    const cfg = sql.queries.find((q) => q.text.startsWith("update content.site_render_config"))!;
    expect(cfg.values[0]).toEqual({ __json: { name: "Acme resources", url: "https://acme.com" } });
  });

  it("rejects a bad domain, a reserved or malformed prefix, and a duplicate project", async () => {
    await expect(createSite(USER, { ...input, domain: "nope" }, fakeSql())).rejects.toBeInstanceOf(SiteInputError);
    await expect(createSite(USER, { ...input, pathPrefix: "/render/x" }, fakeSql())).rejects.toBeInstanceOf(SiteInputError);
    await expect(createSite(USER, { ...input, pathPrefix: "/Resources" }, fakeSql())).rejects.toBeInstanceOf(SiteInputError);
    const dup = fakeSql([[/select id from app\.sites where org_id/, () => [{ id: "s0" }]]]);
    await expect(createSite(USER, input, dup)).rejects.toThrow(/already exists/);
  });
});

describe("deleteSite", () => {
  it("deletes connector secrets first, writes the audit row, then deletes the site (cascade does the rest)", async () => {
    const { deleteSite } = await import("@/lib/app/store");
    const sql = fakeSql([[/select id, secret_ref from context\.context_connections/, () => [{ id: "c1", secret_ref: "ctx/c1" }, { id: "c2", secret_ref: null }]]]);
    const deleted: string[] = [];
    const secrets = { put: async () => "", get: async () => null, delete: async (ref: string) => { deleted.push(ref); } };
    await deleteSite({ id: "s1", org_id: ORG, name: "Acme", canonical_domain: "acme.com", path_prefix: "/resources", edge_hostname: "acme-x.blogedge.aeo.app" }, USER, secrets, sql);
    expect(deleted).toEqual(["ctx/c1"]);
    const texts = sql.queries.map((q) => q.text);
    const audit = texts.findIndex((t) => t.startsWith("insert into app.audit_log"));
    const del = texts.findIndex((t) => t.startsWith("delete from app.sites"));
    expect(audit).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(audit);
    expect(sql.queries[del]!.values).toEqual(["s1", ORG]);
    expect(sql.queries[audit]!.text).toContain("'site.delete'");
    expect(sql.queries[audit]!.values.slice(0, 3)).toEqual([ORG, USER, "s1"]);
  });
});
