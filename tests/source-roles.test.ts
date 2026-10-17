import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { citationRole, recordSnapshot, type SiteOwnership } from "@/lib/demand/store";
import {
  classifySource,
  domainSuffixes,
  isValidDomain,
  loadSourceRoleContext,
  NON_TARGET_SOURCE_ROLES,
  normalizeDomain,
  OVERRIDE_SOURCE_ROLES,
  reclassifySources,
  removeCompetitor,
  saveCompetitor,
  SEED_SOURCE_ROLES,
  SOURCE_ROLE_LABELS,
  SOURCE_ROLES,
  sourceRoleContext,
  SourceRoleInputError,
  type SourceRoleContext,
} from "@/lib/measure/source-roles";
import type { SerpResult } from "@/lib/serp";
import { fakeSql } from "./helpers/fake-sql";

const SITE = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG = "11111111-1111-1111-1111-111111111111";
const OKTA = "eeeeeeee-2000-0000-0000-000000000002";
const ONELOGIN = "eeeeeeee-2000-0000-0000-000000000003";

const ctx = (over: Partial<SourceRoleContext> = {}): SourceRoleContext => ({ ...sourceRoleContext(["acme.com", "acme.io"]), ...over });

describe("domains", () => {
  it("normalises a URL or hostname to the catalogue's key", () => {
    expect(normalizeDomain("https://WWW.Okta.com:443/blog?x=1#y")).toBe("okta.com");
    expect(normalizeDomain("www.acme.com.")).toBe("acme.com");
    expect(normalizeDomain("en.wikipedia.org")).toBe("en.wikipedia.org");
    expect(normalizeDomain("a.com?x/y")).toBe("a.com");
    expect(normalizeDomain("  ")).toBe("");
  });

  it("lists a domain's suffixes of two labels or more, longest first", () => {
    expect(domainSuffixes("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
    expect(domainSuffixes("bbc.co.uk")).toEqual(["bbc.co.uk", "co.uk"]);
    expect(domainSuffixes("localhost")).toEqual([]);
  });

  it("accepts normalised hostnames only", () => {
    expect(isValidDomain("okta.com")).toBe(true);
    expect(isValidDomain("dictionary.cambridge.org")).toBe(true);
    for (const bad of ["www.okta.com", "Okta.com", "okta", "okta.com/blog", "-okta.com", "okta..com", ""]) expect(isValidDomain(bad)).toBe(false);
  });
});

describe("classifySource", () => {
  it("owned first: the site's domains and their subdomains", () => {
    expect(classifySource("docs.acme.io", ctx())).toEqual({ role: "owned", entityId: null });
    // Even when the domain is overridden or named: the site's own is the site's own.
    expect(classifySource("acme.com", ctx({ overrides: { "acme.com": "directory" }, competitors: { "acme.com": OKTA } })).role).toBe("owned");
    expect(classifySource("acme.com.evil.example", ctx()).role).toBe("unknown");
  });

  it("then the site's override, which beats a competitor and the catalogue", () => {
    const c = ctx({ overrides: { "reddit.com": "review_platform", "okta.com": "partner_marketplace" }, competitors: { "okta.com": OKTA } });
    expect(classifySource("old.reddit.com", c)).toEqual({ role: "review_platform", entityId: null });
    expect(classifySource("okta.com", c)).toEqual({ role: "partner_marketplace", entityId: null });
  });

  it("then a named competitor, by its domain or any subdomain, with the entity", () => {
    const c = ctx({ competitors: { "okta.com": OKTA, "onelogin.com": ONELOGIN } });
    expect(classifySource("https://www.blog.okta.com/x", c)).toEqual({ role: "competitor", entityId: OKTA });
    expect(classifySource("onelogin.com", c)).toEqual({ role: "competitor", entityId: ONELOGIN });
    expect(classifySource("notokta.com", c).role).toBe("unknown");
    // A competitor beats the catalogue: a customer who competes with Salesforce names it.
    expect(classifySource("salesforce.com", ctx({ competitors: { "salesforce.com": OKTA } })).role).toBe("competitor");
  });

  it("then the catalogue, the longest listed domain winning, else unknown", () => {
    const c = ctx();
    expect(classifySource("www.reddit.com", c).role).toBe("ugc_forum");
    expect(classifySource("en.wikipedia.org", c).role).toBe("reference_wiki");
    expect(classifySource("g2.com", c).role).toBe("review_platform");
    expect(classifySource("youtu.be", c).role).toBe("video");
    expect(classifySource("microsoft.com", c).role).toBe("vendor_other");
    expect(classifySource("answers.microsoft.com", c).role).toBe("ugc_forum");
    expect(classifySource("appsource.microsoft.com", c).role).toBe("partner_marketplace");
    expect(classifySource("news.ycombinator.com", c).role).toBe("ugc_forum");
    expect(classifySource("ycombinator.com", c).role).toBe("directory");
    expect(classifySource("whatis.techtarget.com", c).role).toBe("reference_wiki");
    expect(classifySource("techtarget.com", c).role).toBe("publisher_editorial");
    expect(classifySource("gartner.com", c).role).toBe("analyst");
    expect(classifySource("rival.example", c)).toEqual({ role: "unknown", entityId: null });
    expect(classifySource("", c)).toEqual({ role: "unknown", entityId: null });
    // Prototype keys are not domains.
    expect(classifySource("constructor", c).role).toBe("unknown");
  });

  it("a catalogue row a person changed wins over the seed at the same domain", () => {
    expect(classifySource("medium.com", ctx({ catalogue: { "medium.com": "ugc_forum" } })).role).toBe("ugc_forum");
    // …and the longest match still decides across the two.
    expect(classifySource("answers.microsoft.com", ctx({ catalogue: { "microsoft.com": "analyst" } })).role).toBe("ugc_forum");
  });

  it("an owned URL is owned whatever its domain field says", () => {
    expect(citationRole("https://www.acme.com/resources/x", "acme.com", { domains: ["acme.com"] }, sourceRoleContext())).toEqual({ role: "owned", entityId: null });
    expect(citationRole("https://reddit.com/r/x", "", { domains: ["acme.com"] }, sourceRoleContext(["acme.com"])).role).toBe("ugc_forum");
  });
});

describe("loadSourceRoleContext", () => {
  it("reads overrides and changed catalogue rows in one query, competitor domains in another; the earliest entity keeps a shared domain", async () => {
    const sql = fakeSql([
      [/from measure\.site_source_overrides/, () => [{ domain: "reddit.com", role: "review_platform", kind: "override" }, { domain: "medium.com", role: "ugc_forum", kind: "catalogue" }]],
      [/from context\.entities/, () => [{ domain: "okta.com", entity_id: OKTA }, { domain: "onelogin.com", entity_id: ONELOGIN }, { domain: "okta.com", entity_id: ONELOGIN }]],
    ]);
    const c = await loadSourceRoleContext(SITE, ORG, sql, ["acme.com"]);
    expect(sql.queries).toHaveLength(2);
    // An override counts only under its site's org, whatever a writer filed it under.
    expect(sql.queries[0]!.values).toEqual([SITE, ORG]);
    expect(sql.queries[0]!.text).toContain("where site_id = $1 and org_id = $2");
    expect(sql.queries[0]!.text).toContain("where classified_by <> 'seed'");
    // Locked for the writer's transaction: a competitor read here cannot be deleted before its citations are written.
    expect(sql.queries[1]!.text).toContain("where e.org_id = $1 and e.type = 'competitor' order by e.created_at, e.id for key share of e");
    expect(c).toEqual({ owned: ["acme.com"], overrides: { "reddit.com": "review_platform" }, catalogue: { "medium.com": "ugc_forum" }, competitors: { "okta.com": OKTA, "onelogin.com": ONELOGIN } });
  });
});

describe("recordSnapshot", () => {
  it("writes each citation's role and, for a competitor, its entity, from the competitors read in its own transaction", async () => {
    let n = 0;
    const sql = fakeSql([
      [/insert into measure\.serp_snapshots/, () => [{ id: `snap-${++n}` }]],
      [/from context\.entities/, () => [{ domain: "okta.com", entity_id: OKTA }]],
    ]);
    // What serp-track memoises: the site's domains, nothing about its competitors.
    const own: SiteOwnership = JSON.parse(JSON.stringify({ siteId: SITE, orgId: ORG, domains: ["acme.com"], pathPrefix: "/resources" }));
    const result: SerpResult = {
      provider: "serpapi",
      query: "sso vs scim",
      locale: { country: "us", language: "en" },
      device: "desktop",
      fetchedAt: "2026-10-01T00:00:00.000Z",
      costUsd: 0.01,
      aiOverview: {
        triggered: true,
        text: "…",
        references: [
          { position: 1, url: "https://www.okta.com/blog/scim", domain: "okta.com", title: "SCIM" },
          { position: 2, url: "https://www.reddit.com/r/sysadmin/x", domain: "reddit.com", title: "thread" },
          { position: 3, url: "https://en.wikipedia.org/wiki/SCIM", domain: "en.wikipedia.org", title: "SCIM" },
        ],
      },
      featuredSnippet: null,
      organic: [{ position: 1, url: "https://acme.com/blog/x", domain: "acme.com", title: "Ours" }],
      paa: [],
      raw: null,
    };
    await recordSnapshot(own, "q1", result, sql);
    const heads = sql.queries.map((q) => q.text.split(" ").slice(0, 3).join(" "));
    expect(heads.slice(0, 3)).toEqual(["select domain, role::text", "select d.domain, e.id", "insert into measure.serp_snapshots"]);
    expect(sql.queries[0]!.values).toEqual([SITE, ORG]);
    const cites = sql.queries.filter((q) => q.text.startsWith("insert into measure.serp_citations"));
    expect(cites[0]!.text).toContain("title, snippet, source_role, entity_id)");
    expect(cites.map((q) => [q.values[4], q.values.at(-2), q.values.at(-1)])).toEqual([
      ["okta.com", "competitor", OKTA],
      ["reddit.com", "ugc_forum", null],
      ["en.wikipedia.org", "reference_wiki", null],
      ["acme.com", "owned", null],
    ]);
  });
});

describe("restating stored roles", () => {
  it("reclassifies through measure.classify_source, only the listed domains and their subdomains, only what changed", async () => {
    const sql = fakeSql([[/with hit as/, () => [{ n: 4 }]]]);
    expect(await reclassifySources([SITE], ["https://www.Okta.com/", "not a domain"], sql)).toBe(4);
    const q = sql.queries[0]!;
    expect(q.values).toEqual([[SITE], ["okta.com"]]);
    expect(q.text).toContain("c.domain = l.domain or right(c.domain, length(l.domain) + 1) = '.' || l.domain");
    expect(q.text).toContain("cls as materialized ( select h.site_id, h.domain, r.role, r.entity_id from hit h cross join lateral measure.classify_source(h.site_id, h.domain) r");
    expect(q.text).toContain("(c.source_role is distinct from cls.role or c.entity_id is distinct from cls.entity_id)");
    expect(await reclassifySources([], ["okta.com"], sql)).toBe(0);
    expect(await reclassifySources([SITE], ["nope"], sql)).toBe(0);
    expect(sql.queries).toHaveLength(1);
  });
});

describe("saveCompetitor", () => {
  const sites = () => fakeSql([[/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com", "www.acme.io"] }]]]);

  it("refuses a malformed domain, the org's own domains and an entity of another org", async () => {
    await expect(saveCompetitor({ id: ORG }, { name: "Okta", domains: ["okta"], aliases: [] }, null, sites())).rejects.toThrow('"okta" is not a domain.');
    await expect(saveCompetitor({ id: ORG }, { name: "Us", domains: ["blog.acme.io"], aliases: [] }, null, sites())).rejects.toBeInstanceOf(SourceRoleInputError);
    const sql = sites();
    await expect(saveCompetitor({ id: ORG }, { entityId: OKTA, name: "Okta", domains: ["okta.com"], aliases: [] }, null, sql)).rejects.toThrow("Competitor not found.");
    const lookup = sql.queries.find((q) => q.text.includes("for update"))!;
    expect(lookup.text).toContain("where id = $1 and org_id = $2 for update");
    expect(lookup.values).toEqual([OKTA, ORG]);
  });

  it("never turns the brand into a competitor", async () => {
    const sql = fakeSql([
      [/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com"] }]],
      [/for update/, () => [{ id: "brand", type: "brand", name: "Acme", domains: [], seeded: false }]],
    ]);
    await expect(saveCompetitor({ id: ORG }, { name: "Acme", domains: [], aliases: [] }, null, sql)).rejects.toThrow("Acme is your brand.");
  });

  it("never rewrites a product, an integration or any other typed entity of the same name", async () => {
    const refuse = async (type: string, message: string) => {
      const sql = fakeSql([
        [/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com"] }]],
        [/for update/, () => [{ id: "e", type, name: "Salesforce", domains: [], aliases: ["SFDC"], seeded: false }]],
      ]);
      await expect(saveCompetitor({ id: ORG }, { name: "salesforce", domains: ["salesforce.com"], aliases: [] }, null, sql)).rejects.toThrow(message);
      expect(sql.queries.some((q) => q.text.startsWith("update context.entities"))).toBe(false);
    };
    await refuse("product", "Salesforce is one of your products.");
    await refuse("integration", "Salesforce is in your brand brain as an integration; give the competitor another name.");
    await refuse("customer", "as a customer;");
  });

  it("naming an entity that exists adds to its aliases and domains; editing one by id sets them", async () => {
    const run = async (entityId: string | null) => {
      const sql = fakeSql([
        [/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com"] }]],
        [/for update/, () => [{ id: OKTA, type: entityId ? "competitor" : "other", name: "Okta", domains: ["okta.com"], aliases: ["Okta Inc"], seeded: false }]],
        [/^update context\.entities set name/, () => [{ id: OKTA }]],
      ]);
      await saveCompetitor({ id: ORG }, { entityId, name: "Okta", domains: ["auth0.com"], aliases: ["Auth0"] }, null, sql);
      const update = sql.queries.find((q) => q.text.startsWith("update context.entities set name"))!;
      expect(update.text).toContain("metadata = (metadata - 'seeded_from' - 'removed_as_competitor_at' - 'removed_by' - 'former_domains') ||");
      return update.values.slice(1, 3);
    };
    expect(await run(null)).toEqual([["okta.com", "auth0.com"], ["Okta Inc", "Auth0"]]);
    expect(await run(OKTA)).toEqual([["auth0.com"], ["Auth0"]]);
  });

  it("takes the domains from any other competitor, drops an emptied seeded one, and restates every site of the org", async () => {
    const sql = fakeSql([
      [/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com"] }, { id: "site-2", domains: ["acme.io"] }]],
      [/for update/, () => [{ id: "seeded", type: "competitor", name: "okta.com", domains: ["okta.com"], seeded: true }]],
      [/^update context\.entities set name/, () => [{ id: "seeded" }]],
      [/^update context\.entities set domains/, () => [{ id: "other", domains: [] }]],
      [/with hit as/, () => [{ n: 7 }]],
    ]);
    const r = await saveCompetitor({ id: ORG }, { name: "Okta", domains: ["https://www.okta.com", "auth0.com"], aliases: ["Okta Workforce", "okta"] }, "user-1", sql);
    expect(r).toEqual({ entityId: "seeded", reclassified: 7, clearedOverrides: [] });
    const update = sql.queries.find((q) => q.text.startsWith("update context.entities set name"))!;
    expect(update.text).toContain("metadata = (metadata - 'seeded_from' - 'removed_as_competitor_at' - 'removed_by' - 'former_domains') ||");
    expect(update.values.slice(0, 3)).toEqual(["Okta", ["okta.com", "auth0.com"], ["Okta Workforce"]]);
    expect(sql.queries.find((q) => q.text.startsWith("delete from context.entities"))!.values).toEqual([["other"]]);
    expect(sql.queries.find((q) => q.text.startsWith("with hit as"))!.values).toEqual([[SITE, "site-2"], ["okta.com", "auth0.com"]]);
  });

  it("clears the saving site's own role for the domains the save names: all of them when adding, the new ones when editing", async () => {
    const run = async (entityId: string | null, siteId: string | null) => {
      const sql = fakeSql([
        [/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com"] }]],
        [/for update/, () => [{ id: OKTA, type: "competitor", name: "Okta", domains: ["okta.com"], aliases: [], seeded: false }]],
        [/^update context\.entities set name/, () => [{ id: OKTA }]],
        [/^delete from measure\.site_source_overrides/, (q) => (q.values[2] as string[]).map((domain) => ({ domain }))],
      ]);
      const r = await saveCompetitor({ id: ORG }, { entityId, name: "Okta", domains: ["auth0.com", "okta.com"], aliases: [], siteId }, null, sql);
      const del = sql.queries.find((q) => q.text.startsWith("delete from measure.site_source_overrides"));
      if (del) expect(del.text).toContain("where site_id = $1 and org_id = $2 and domain = any ($3::text[])");
      return [r.clearedOverrides, del?.values.slice(0, 2)];
    };
    expect(await run(null, SITE)).toEqual([["auth0.com", "okta.com"], [SITE, ORG]]);
    expect(await run(OKTA, SITE)).toEqual([["auth0.com"], [SITE, ORG]]);
    expect(await run(null, null)).toEqual([[], undefined]);
  });
});

describe("removeCompetitor", () => {
  it("finds the competitor only within the org, deletes a seeded one and demotes a named one", async () => {
    const run = async (seeded: boolean) => {
      const sql = fakeSql([
        [/from app\.sites s where s\.org_id/, () => [{ id: SITE, domains: ["acme.com"] }]],
        [/for update/, () => [{ id: OKTA, domains: ["okta.com"], seeded }]],
        [/with hit as/, () => [{ n: 2 }]],
      ]);
      expect(await removeCompetitor({ id: ORG }, OKTA, null, sql)).toEqual({ reclassified: 2 });
      const lookup = sql.queries.find((q) => q.text.includes("for update"))!;
      expect(lookup.text).toContain("where id = $1 and org_id = $2 and type = 'competitor' for update");
      expect(lookup.values).toEqual([OKTA, ORG]);
      return sql.queries;
    };
    const heads = (qs: { text: string }[]) => qs.map((q) => q.text.split(" ").slice(0, 3).join(" "));
    expect(heads(await run(true))).toContain("delete from context.entities");
    const named = await run(false);
    expect(heads(named)).not.toContain("delete from context.entities");
    // Demoted, it keeps its aliases but not its domains, and remembers both the domains and the removal.
    const demote = named.find((q) => q.text.startsWith("update context.entities set"))!;
    expect(demote.text).toContain("set type = 'other', domains = '{}', metadata = metadata ||");
    expect(demote.values[0]).toMatchObject({ __json: { removed_by: null, former_domains: ["okta.com"] } });
    await expect(removeCompetitor({ id: ORG }, OKTA, null, fakeSql())).rejects.toThrow("Competitor not found.");
  });
});

describe("roles", () => {
  it("every role has a label; overrides cannot claim ownership or name a competitor", () => {
    expect(Object.keys(SOURCE_ROLE_LABELS).sort()).toEqual([...SOURCE_ROLES].sort());
    expect(OVERRIDE_SOURCE_ROLES).not.toContain("owned");
    expect(OVERRIDE_SOURCE_ROLES).not.toContain("competitor");
    expect(OVERRIDE_SOURCE_ROLES).toContain("unknown");
  });
});

describe("catalogue seed", () => {
  const migration = readFileSync(fileURLToPath(new URL("../supabase/migrations/0022_source_roles.sql", import.meta.url)), "utf8");

  /** The rows 0022 inserts into measure.source_domains, parsed from its VALUES list. */
  function migrationSeed(): Record<string, string> {
    const start = migration.indexOf("insert into measure.source_domains (domain, role) values");
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, migration.indexOf(";", start));
    const rows = [...body.matchAll(/\('([^']+)', '([a-z_]+)'\)/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(new Set(rows.map(([d]) => d)).size).toBe(rows.length);
    return Object.fromEntries(rows);
  }

  it("the migration's rows are exactly SEED_SOURCE_ROLES", () => {
    expect(migrationSeed()).toEqual({ ...SEED_SOURCE_ROLES });
  });

  it("the pages it drops from the structural target are exactly NON_TARGET_SOURCE_ROLES", () => {
    const listed = /delete from measure\.competitor_pages p using roles[\s\S]*?roles\.role in \(([^)]*)\);/.exec(migration);
    expect(listed).not.toBeNull();
    expect([...listed![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...NON_TARGET_SOURCE_ROLES].sort());
  });

  it("is about two hundred well-formed domains, none with a site-relative role", () => {
    const entries = Object.entries(SEED_SOURCE_ROLES);
    expect(entries.length).toBeGreaterThanOrEqual(200);
    for (const [domain, role] of entries) {
      expect(isValidDomain(domain), domain).toBe(true);
      expect(["owned", "competitor", "unknown"]).not.toContain(role);
    }
    // The ones the competitor lists used to count as rivals.
    expect(SEED_SOURCE_ROLES["reddit.com"]).toBe("ugc_forum");
    expect(SEED_SOURCE_ROLES["g2.com"]).toBe("review_platform");
    expect(SEED_SOURCE_ROLES["wikipedia.org"]).toBe("reference_wiki");
    expect(SEED_SOURCE_ROLES["capterra.com"]).toBe("review_platform");
    expect(SEED_SOURCE_ROLES["youtube.com"]).toBe("video");
    expect(SEED_SOURCE_ROLES["linkedin.com"]).toBe("professional_social");
  });
});
