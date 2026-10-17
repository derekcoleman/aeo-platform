import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { namedCompetitors, sourcesShapingAnswers } from "@/lib/app/strategy";
import { upsertEntity } from "@/lib/context/entities";
import { citationGaps, loadSiteOwnership, recordSnapshot, type SiteOwnership } from "@/lib/demand/store";
import { classifySource, loadSourceRoleContext, removeCompetitor, saveCompetitor, seedCompetitorsFromDomains, setSourceOverride } from "@/lib/measure/source-roles";
import { opportunitiesFromCitationGaps } from "@/lib/pipeline/opportunities";
import type { SerpResult } from "@/lib/serp";
import { collectCompetitorUrls, listCompetitorPages, pruneNonTargetPages, structuralTargetFor } from "@/lib/strategy/competitors";

/**
 * Source roles against the real schema: the insert trigger and
 * measure.classify_source agree with classifySource, naming a competitor or
 * overriding a role restates the citations already stored, and the read
 * models split named competitors from the sites that shape answers. Runs
 * only with AEO_TEST_DATABASE_URL; everything it creates is under one
 * throwaway organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("source roles against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const Q = randomUUID();
  const RIVAL = "okta-roles.test";
  const OWN = "acme-roles.test";

  async function roleOf(domain: string) {
    const rows = await sql<{ source_role: string; entity_id: string | null }[]>`
      select distinct source_role::text as source_role, entity_id from measure.serp_citations where site_id = ${SITE} and domain = ${domain}`;
    return rows;
  }

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Roles test', ${`roles-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Roles test', ${OWN}, '/resources', ${`rl-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score)
      values (${Q}, ${SITE}, 'sso vs scim', 'sso vs scim', 'autocomplete', 'us-en', 'desktop', 40)`;
    // Recorded before anyone named a competitor: the rival is unknown, the crowd is classified by the catalogue.
    const [s] = await sql<{ id: string }[]>`
      insert into measure.serp_snapshots (site_id, question_id, provider, fetched_at, locale, device, aio_triggered)
      values (${SITE}, ${Q}, 'serpapi', now() - interval '1 day', 'us-en', 'desktop', true) returning id`;
    const cites = [`https://${RIVAL}/scim`, `https://blog.${RIVAL}/sso`, "https://www.reddit.com/r/sysadmin/x", "https://www.g2.com/products/x", "https://medium.com/@x/scim"];
    for (const [i, url] of cites.entries()) {
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, 'ai_overview', ${url}, ${new URL(url).hostname.replace(/^www\./, "")}, ${i + 1}, false)`;
    }
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  it("classifies rows written without a role on insert", async () => {
    expect(await roleOf(RIVAL)).toEqual([{ source_role: "unknown", entity_id: null }]);
    expect(await roleOf("reddit.com")).toEqual([{ source_role: "ugc_forum", entity_id: null }]);
    expect(await roleOf("g2.com")).toEqual([{ source_role: "review_platform", entity_id: null }]);
  });

  it("naming a competitor restates the citations already stored, subdomains included", async () => {
    const r = await saveCompetitor({ id: ORG }, { name: "Okta", domains: [`https://www.${RIVAL}/`], aliases: ["Okta Workforce"] }, null, sql);
    expect(r.reclassified).toBe(2);
    expect(await roleOf(RIVAL)).toEqual([{ source_role: "competitor", entity_id: r.entityId }]);
    expect(await roleOf(`blog.${RIVAL}`)).toEqual([{ source_role: "competitor", entity_id: r.entityId }]);
    // Saving again changes nothing.
    expect((await saveCompetitor({ id: ORG }, { entityId: r.entityId, name: "Okta", domains: [RIVAL], aliases: ["Okta Workforce"] }, null, sql)).reclassified).toBe(0);
  });

  it("classifySource with the loaded context agrees with measure.classify_source", async () => {
    await setSourceOverride({ id: SITE }, "medium.com", "vendor_other", null, sql);
    const own = (await loadSiteOwnership(SITE, sql))!;
    const roles = await loadSourceRoleContext(SITE, ORG, sql, own.domains);
    for (const domain of [RIVAL, `www.blog.${RIVAL}`, OWN, `docs.${OWN}`, "reddit.com", "answers.microsoft.com", "microsoft.com", "en.wikipedia.org", "medium.com", "unknown-roles.test", ""]) {
      const [db] = await sql<{ role: string; entity_id: string | null }[]>`select role::text as role, entity_id from measure.classify_source(${SITE}, ${domain})`;
      expect(classifySource(domain, roles), domain).toEqual({ role: db!.role, entityId: db!.entity_id });
    }
    await setSourceOverride({ id: SITE }, "medium.com", null, null, sql);
  });

  it("an override restates its domain, and clearing it hands the domain back to the catalogue", async () => {
    expect((await setSourceOverride({ id: SITE }, "https://www.reddit.com", "review_platform", null, sql)).reclassified).toBe(1);
    expect(await roleOf("reddit.com")).toEqual([{ source_role: "review_platform", entity_id: null }]);
    expect((await setSourceOverride({ id: SITE }, "reddit.com", null, null, sql)).reclassified).toBe(1);
    expect(await roleOf("reddit.com")).toEqual([{ source_role: "ugc_forum", entity_id: null }]);
  });

  it("recordSnapshot classifies with the site's competitors", async () => {
    const own = (await loadSiteOwnership(SITE, sql))!;
    const result: SerpResult = {
      provider: "serpapi",
      query: "sso vs scim",
      locale: { country: "us", language: "en" },
      device: "desktop",
      fetchedAt: new Date().toISOString(),
      costUsd: 0,
      aiOverview: { triggered: true, text: "…", references: [{ position: 1, url: `https://docs.${RIVAL}/a`, domain: `docs.${RIVAL}`, title: "a" }, { position: 2, url: "https://youtu.be/x", domain: "youtu.be", title: "v" }] },
      featuredSnippet: null,
      organic: [],
      paa: [],
      raw: null,
    };
    const rec = await recordSnapshot(own, Q, result, sql);
    const rows = await sql<{ domain: string; source_role: string; entity_id: string | null }[]>`
      select domain, source_role::text as source_role, entity_id from measure.serp_citations where serp_snapshot_id = ${rec.snapshotId} order by position`;
    const [okta] = await sql<{ id: string }[]>`select id from context.entities where org_id = ${ORG} and name = 'Okta'`;
    expect(rows).toEqual([
      { domain: `docs.${RIVAL}`, source_role: "competitor", entity_id: okta!.id },
      { domain: "youtu.be", source_role: "video", entity_id: null },
    ]);
  });

  it("the read models split named competitors from the sources shaping answers, and gaps name the competitors", async () => {
    const named = await namedCompetitors(SITE, {}, sql);
    expect(named.map((n) => [n.name, n.domains, n.unconfirmed, n.citations])).toEqual([["Okta", [RIVAL], false, 3]]);
    const groups = await sourcesShapingAnswers(SITE, {}, sql);
    const roles = Object.fromEntries(groups.map((g) => [g.role, g.domains.map((d) => d.domain).sort()]));
    expect(roles).toEqual({ ugc_forum: ["reddit.com"], review_platform: ["g2.com"], publisher_editorial: ["medium.com"], video: ["youtu.be"] });
    const [gap] = await citationGaps(SITE, 10, sql);
    expect(gap!.named_competitor_domains).toEqual([`docs.${RIVAL}`]);
    // The structural targets leave the crowd out and keep the rival.
    const urls = (await collectCompetitorUrls(SITE, {}, sql)).map((u) => u.domain).sort();
    expect(urls).toEqual([`blog.${RIVAL}`, `docs.${RIVAL}`, "medium.com", RIVAL]);
  });

  it("a topic's watched domain becomes an unconfirmed competitor, and confirming it under a real name folds it in", async () => {
    const seeded = await seedCompetitorsFromDomains({ id: ORG }, ["https://www.jumpcloud-roles.test", "reddit.com", OWN], sql);
    expect(seeded.added).toEqual(["jumpcloud-roles.test"]);
    const before = await namedCompetitors(SITE, {}, sql);
    expect(before.find((c) => c.name === "jumpcloud-roles.test")).toMatchObject({ unconfirmed: true, domains: ["jumpcloud-roles.test"] });
    const r = await saveCompetitor({ id: ORG }, { name: "JumpCloud", domains: ["jumpcloud-roles.test"], aliases: [] }, null, sql);
    const after = await sql<{ id: string; name: string; seeded: boolean }[]>`
      select id, name, metadata ? 'seeded_from' as seeded from context.entities where org_id = ${ORG} and 'jumpcloud-roles.test' = any (domains)`;
    expect(after).toEqual([{ id: r.entityId, name: "JumpCloud", seeded: false }]);
    expect(before.find((c) => c.name === "jumpcloud-roles.test")!.entity_id).toBe(r.entityId);
  });

  it("removing a competitor deletes a seeded one and demotes a named one, restating its citations", async () => {
    await seedCompetitorsFromDomains({ id: ORG }, ["rippling-roles.test"], sql);
    const [seeded] = await sql<{ id: string }[]>`select id from context.entities where org_id = ${ORG} and name = 'rippling-roles.test'`;
    await removeCompetitor({ id: ORG }, seeded!.id, null, sql);
    expect(await sql`select 1 from context.entities where id = ${seeded!.id}`).toHaveLength(0);

    const [okta] = await sql<{ id: string }[]>`select id from context.entities where org_id = ${ORG} and name = 'Okta'`;
    expect((await removeCompetitor({ id: ORG }, okta!.id, null, sql)).reclassified).toBe(3);
    expect(await roleOf(RIVAL)).toEqual([{ source_role: "unknown", entity_id: null }]);
    const [kept] = await sql<{ type: string; aliases: string[] }[]>`select type::text as type, aliases from context.entities where id = ${okta!.id}`;
    expect(kept).toEqual({ type: "other", aliases: ["Okta Workforce"] });
    expect((await namedCompetitors(SITE, {}, sql)).map((c) => c.name)).toEqual(["JumpCloud"]);
    await expect(removeCompetitor({ id: ORG }, okta!.id, null, sql)).rejects.toThrow("Competitor not found.");
  });

  it("a removed competitor stays removed when a re-crawl's profile names it again, until someone names it on the Strategy page", async () => {
    const [okta] = await sql<{ id: string; domains: string[]; former: string[] }[]>`
      select id, domains, metadata->'former_domains' as former from context.entities where org_id = ${ORG} and name = 'Okta'`;
    expect(okta).toMatchObject({ domains: [], former: [RIVAL] });
    // What applyBusinessProfile does on every re-crawl.
    expect((await upsertEntity(ORG, { type: "competitor", name: "Okta", aliases: ["Okta Inc"] }, sql)).type).toBe("other");
    expect(classifySource(RIVAL, await loadSourceRoleContext(SITE, ORG, sql, [OWN]))).toEqual({ role: "unknown", entityId: null });
    expect(await roleOf(RIVAL)).toEqual([{ source_role: "unknown", entity_id: null }]);

    const r = await saveCompetitor({ id: ORG }, { name: "Okta", domains: [RIVAL], aliases: [] }, null, sql);
    expect(r).toEqual({ entityId: okta!.id, reclassified: 3, clearedOverrides: [] });
    const [back] = await sql<{ type: string; name: string; aliases: string[]; removed: boolean }[]>`
      select type::text as type, name, aliases, metadata ? 'removed_as_competitor_at' as removed from context.entities where id = ${okta!.id}`;
    expect({ ...back, aliases: [...back!.aliases].sort() }).toEqual({ type: "competitor", name: "Okta", aliases: ["Okta Inc", "Okta Workforce"], removed: false });
    expect(await roleOf(RIVAL)).toEqual([{ source_role: "competitor", entity_id: okta!.id }]);
  });

  it("naming a competitor never rewrites an entity of another type that has the name", async () => {
    const [sf] = await sql<{ id: string }[]>`
      insert into context.entities (org_id, type, name, aliases) values (${ORG}, 'integration', 'Salesforce', '{SFDC}') returning id`;
    await expect(saveCompetitor({ id: ORG }, { name: "Salesforce", domains: ["salesforce-roles.test"], aliases: [] }, null, sql)).rejects.toThrow(
      "Salesforce is in your brand brain as an integration; give the competitor another name.",
    );
    expect(await sql`select type::text as type, aliases, domains from context.entities where id = ${sf!.id}`).toEqual([{ type: "integration", aliases: ["SFDC"], domains: [] }]);
  });

  it("a rival cited on two of its hosts is one named competitor in a gap's score", async () => {
    const Q2 = randomUUID();
    await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score)
      values (${Q2}, ${SITE}, 'best scim tool', 'best scim tool', 'autocomplete', 'us-en', 'desktop', 30)`;
    const [s] = await sql<{ id: string }[]>`
      insert into measure.serp_snapshots (site_id, question_id, provider, fetched_at, locale, device, aio_triggered)
      values (${SITE}, ${Q2}, 'serpapi', now(), 'us-en', 'desktop', true) returning id`;
    for (const [i, domain] of [RIVAL, `blog.${RIVAL}`, "reddit.com"].entries()) {
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, 'ai_overview', ${`https://${domain}/scim`}, ${domain}, ${i + 1}, false)`;
    }
    const gap = (await citationGaps(SITE, 10, sql)).find((g) => g.question_id === Q2)!;
    expect(gap).toMatchObject({ named_competitor_domains: [`blog.${RIVAL}`, RIVAL], named_competitors: 1 });
    const [o] = opportunitiesFromCitationGaps([gap]);
    expect(o!.scoreBreakdown).toMatchObject({ citationGap: { value: 73 }, difficulty: { value: 38 } });
  });

  it("pages analysed on a forum or a review site leave the structural target, at once and for good", async () => {
    const page = (domain: string, citations: number) => sql`
      insert into measure.competitor_pages (site_id, url, domain, content_type, word_count, citations_30d, fetched_at)
      values (${SITE}, ${`https://${domain}/scim`}, ${domain}, 'guide', 900, ${citations}, now())`;
    // Analysed before roles existed: the forum thread was the most cited "competitor" page.
    await page("reddit.com", 25);
    await page("medium.com", 2);
    await page(RIVAL, 1);
    expect((await listCompetitorPages(SITE, {}, sql)).map((p) => p.domain)).toEqual(["medium.com", RIVAL]);
    expect((await structuralTargetFor(SITE, null, sql)).topPages.map((p) => p.domain)).toEqual(["medium.com", RIVAL]);
    // An override between analyses takes effect on the next read.
    await setSourceOverride({ id: SITE }, "medium.com", "ugc_forum", null, sql);
    expect((await listCompetitorPages(SITE, {}, sql)).map((p) => p.domain)).toEqual([RIVAL]);
    // The next analysis drops them.
    expect(await pruneNonTargetPages(SITE, sql)).toBe(2);
    expect(await sql`select domain from measure.competitor_pages where site_id = ${SITE}`).toEqual([{ domain: RIVAL }]);
    await setSourceOverride({ id: SITE }, "medium.com", null, null, sql);
  });

  describe("a tracking run's snapshots", () => {
    const Q3 = randomUUID();
    const snapshot = (references: { url: string; domain: string }[], organic: SerpResult["organic"] = []): SerpResult => ({
      provider: "serpapi",
      query: "scim provisioning",
      locale: { country: "us", language: "en" },
      device: "desktop",
      fetchedAt: new Date().toISOString(),
      costUsd: 0,
      aiOverview: { triggered: true, text: "…", references: references.map((r, i) => ({ ...r, position: i + 1, title: r.domain })) },
      featuredSnippet: null,
      organic,
      paa: [],
      raw: null,
    });
    const snapshotsOf = async () =>
      sql<{ citations: number; owned: number }[]>`
        select (select count(*) from measure.serp_citations c where c.serp_snapshot_id = s.id)::int as citations,
               (select count(*) from measure.serp_citations c where c.serp_snapshot_id = s.id and c.is_owned)::int as owned
        from measure.serp_snapshots s where s.question_id = ${Q3} order by s.fetched_at`;

    beforeAll(async () => {
      await sql`insert into measure.questions (id, site_id, text, normalized, source, locale, device, demand_score)
        values (${Q3}, ${SITE}, 'scim provisioning', 'scim provisioning', 'autocomplete', 'us-en', 'desktop', 5)`;
    });

    it("are classified against the competitors as they are when written, not as the run's memoised site load had them", async () => {
      await seedCompetitorsFromDomains({ id: ORG }, ["seeded-roles.test"], sql);
      const [seeded] = await sql<{ id: string }[]>`select id from context.entities where org_id = ${ORG} and name = 'seeded-roles.test'`;
      // What serp-track's "load-site" step memoises before the rest of its run.
      const own = JSON.parse(JSON.stringify(await loadSiteOwnership(SITE, sql))) as SiteOwnership;
      // Meanwhile on the Strategy page: the seeded rival is "not a competitor" (deleted), and another is named.
      await removeCompetitor({ id: ORG }, seeded!.id, null, sql);
      const named = await saveCompetitor({ id: ORG }, { name: "Named Rival", domains: ["named-roles.test"], aliases: [] }, null, sql);

      const rec = await recordSnapshot(own, Q3, snapshot([{ url: "https://seeded-roles.test/a", domain: "seeded-roles.test" }, { url: "https://named-roles.test/b", domain: "named-roles.test" }, { url: `https://${OWN}/resources/scim`, domain: OWN }]), sql);
      expect(rec).toMatchObject({ citations: 3, ownedCitations: 1 });
      const rows = await sql<{ domain: string; source_role: string; entity_id: string | null }[]>`
        select domain, source_role::text as source_role, entity_id from measure.serp_citations where serp_snapshot_id = ${rec.snapshotId} order by position`;
      expect(rows).toEqual([
        { domain: "seeded-roles.test", source_role: "unknown", entity_id: null },
        { domain: "named-roles.test", source_role: "competitor", entity_id: named.entityId },
        { domain: OWN, source_role: "owned", entity_id: null },
      ]);
      expect(await snapshotsOf()).toEqual([{ citations: 3, owned: 1 }]);
    });

    it("leave nothing behind when a citation cannot be written", async () => {
      const own = (await loadSiteOwnership(SITE, sql))!;
      const result = snapshot([{ url: `https://${OWN}/resources/scim`, domain: OWN }], [{ position: 40_000, url: "https://organic-roles.test/x", domain: "organic-roles.test", title: "x" }]);
      await expect(recordSnapshot(own, Q3, result, sql)).rejects.toThrow(/smallint/);
      // The earlier snapshot is still the question's latest, not an AI Overview that cited no one.
      expect(await snapshotsOf()).toEqual([{ citations: 3, owned: 1 }]);
    });
  });

  it("naming a domain this site set a role for clears that role here, so the competitor counts", async () => {
    const SITE2 = randomUUID();
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE2}, ${ORG}, 'Roles test 2', 'acme-roles-two.test', '/resources', ${`rl-${SITE2.slice(0, 8)}.blogedge.test`}, 'active')`;
    await setSourceOverride({ id: SITE }, "medium.com", "vendor_other", null, sql);
    await setSourceOverride({ id: SITE2 }, "medium.com", "publisher_editorial", null, sql);
    expect(await roleOf("medium.com")).toEqual([{ source_role: "vendor_other", entity_id: null }]);

    const r = await saveCompetitor({ id: ORG }, { name: "Medium", domains: ["medium.com"], aliases: [], siteId: SITE }, null, sql);
    expect(r.clearedOverrides).toEqual(["medium.com"]);
    expect(await roleOf("medium.com")).toEqual([{ source_role: "competitor", entity_id: r.entityId }]);
    // Another site's own call is its own, and still outranks the competitor there.
    expect(await sql`select site_id, role::text as role from measure.site_source_overrides where domain = 'medium.com' and org_id = ${ORG}`).toEqual([{ site_id: SITE2, role: "publisher_editorial" }]);
    // Saving it again from the edit form names nothing new and clears nothing.
    expect((await saveCompetitor({ id: ORG }, { entityId: r.entityId, name: "Medium", domains: ["medium.com"], aliases: ["Medium Blog"], siteId: SITE2 }, null, sql)).clearedOverrides).toEqual([]);
  });
});
