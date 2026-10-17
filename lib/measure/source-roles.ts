import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Source roles: what kind of site a cited domain is. "Who gets cited instead
 * of us" counted Reddit, G2 and Wikipedia as competitors; a role separates
 * the rivals the customer names (context.entities of type competitor, with
 * their domains) from the sites that shape AI answers without competing:
 * forums, video, social, review platforms, reference wikis, publishers,
 * analysts, marketplaces and directories. Those are earned-media targets,
 * not pages a brief must beat.
 *
 * Precedence, the same here and in measure.classify_source() (migration
 * 0022, which backfilled every citation with it):
 *   1. owned       the site's own domains (SiteOwnership.domains)
 *   2. override    the site's measure.site_source_overrides row
 *   3. competitor  a domain of one of the org's competitor entities
 *   4. catalogue   measure.source_domains, seeded from SEED_SOURCE_ROLES
 *   5. unknown
 * A domain matches a listed one when it equals it or is a subdomain of it
 * (blog.okta.com → okta.com, en.wikipedia.org → wikipedia.org); within a
 * tier the longest listed match wins, so answers.microsoft.com is a forum
 * while microsoft.com is a vendor.
 */

export const SOURCE_ROLES = [
  "owned",
  "competitor",
  "ugc_forum",
  "video",
  "professional_social",
  "review_platform",
  "reference_wiki",
  "publisher_editorial",
  "analyst",
  "partner_marketplace",
  "directory",
  "vendor_other",
  "unknown",
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];
/** The roles the global catalogue can hold: owned and competitor depend on the site, unknown is the absence of a row. */
export type CatalogueSourceRole = Exclude<SourceRole, "owned" | "competitor" | "unknown">;

export const SOURCE_ROLE_LABELS: Record<SourceRole, string> = {
  owned: "Your site",
  competitor: "Competitor",
  ugc_forum: "Forums and communities",
  video: "Video",
  professional_social: "Social",
  review_platform: "Review sites",
  reference_wiki: "Reference and wikis",
  publisher_editorial: "Publishers and media",
  analyst: "Analysts",
  partner_marketplace: "Marketplaces",
  directory: "Directories",
  vendor_other: "Other vendors",
  unknown: "Not classified yet",
};

/**
 * Roles whose pages are not the structural target a brief has to beat: the
 * customer's own, and sites that are cited for what their community or
 * listing says rather than for a page anyone could write. Publishers,
 * analysts, other vendors and unknown domains stay, so a new site with no
 * named competitors still gets a target.
 */
export const NON_TARGET_SOURCE_ROLES: readonly SourceRole[] = [
  "owned",
  "ugc_forum",
  "video",
  "professional_social",
  "review_platform",
  "reference_wiki",
  "directory",
  "partner_marketplace",
];

/**
 * What a site's override can set. Owned follows the site's domains and a
 * competitor is named through the competitor form (an entity with domains
 * and aliases), so neither is an override.
 */
export const OVERRIDE_SOURCE_ROLES = SOURCE_ROLES.filter((r): r is Exclude<SourceRole, "owned" | "competitor"> => r !== "owned" && r !== "competitor");

/**
 * The catalogue's seed, and the source of truth for it: migration 0022
 * inserts exactly these rows into measure.source_domains, and
 * tests/source-roles.test.ts fails when the two drift. Gartner Peer
 * Insights and AWS Marketplace live under paths of gartner.com and
 * aws.amazon.com, which a domain role cannot separate; those domains carry
 * their owner's role.
 */
export const SEED_SOURCE_ROLES: Readonly<Record<string, CatalogueSourceRole>> = {
  // ── forums and communities ──
  "reddit.com": "ugc_forum",
  "quora.com": "ugc_forum",
  "stackoverflow.com": "ugc_forum",
  "stackexchange.com": "ugc_forum",
  "superuser.com": "ugc_forum",
  "serverfault.com": "ugc_forum",
  "askubuntu.com": "ugc_forum",
  "mathoverflow.net": "ugc_forum",
  "news.ycombinator.com": "ugc_forum",
  "github.com": "ugc_forum",
  "gitlab.com": "ugc_forum",
  "dev.to": "ugc_forum",
  "indiehackers.com": "ugc_forum",
  "spiceworks.com": "ugc_forum",
  "slashdot.org": "ugc_forum",
  "experts-exchange.com": "ugc_forum",
  "answers.com": "ugc_forum",
  "lobste.rs": "ugc_forum",
  "zhihu.com": "ugc_forum",
  "answers.microsoft.com": "ugc_forum",
  "techcommunity.microsoft.com": "ugc_forum",
  "community.atlassian.com": "ugc_forum",
  "community.hubspot.com": "ugc_forum",
  "community.shopify.com": "ugc_forum",
  "community.cloudflare.com": "ugc_forum",
  "groups.google.com": "ugc_forum",
  // ── video ──
  "youtube.com": "video",
  "youtu.be": "video",
  "vimeo.com": "video",
  "tiktok.com": "video",
  "twitch.tv": "video",
  "dailymotion.com": "video",
  "loom.com": "video",
  "rumble.com": "video",
  "ted.com": "video",
  // ── social ──
  "linkedin.com": "professional_social",
  "lnkd.in": "professional_social",
  "x.com": "professional_social",
  "twitter.com": "professional_social",
  "facebook.com": "professional_social",
  "instagram.com": "professional_social",
  "threads.net": "professional_social",
  "bsky.app": "professional_social",
  "mastodon.social": "professional_social",
  "pinterest.com": "professional_social",
  // ── review platforms ──
  "g2.com": "review_platform",
  "g2crowd.com": "review_platform",
  "capterra.com": "review_platform",
  "capterra.co.uk": "review_platform",
  "trustradius.com": "review_platform",
  "getapp.com": "review_platform",
  "softwareadvice.com": "review_platform",
  "trustpilot.com": "review_platform",
  "peerspot.com": "review_platform",
  "sitejabber.com": "review_platform",
  "yelp.com": "review_platform",
  "tripadvisor.com": "review_platform",
  "glassdoor.com": "review_platform",
  "saasworthy.com": "review_platform",
  "softwaresuggest.com": "review_platform",
  "crozdesk.com": "review_platform",
  "featuredcustomers.com": "review_platform",
  "financesonline.com": "review_platform",
  "selecthub.com": "review_platform",
  "itqlick.com": "review_platform",
  "comparably.com": "review_platform",
  "sourceforge.net": "review_platform",
  "clutch.co": "review_platform",
  "goodfirms.co": "review_platform",
  "consumeraffairs.com": "review_platform",
  "reviews.io": "review_platform",
  "bbb.org": "review_platform",
  "softwareworld.co": "review_platform",
  "techjockey.com": "review_platform",
  // ── reference and wikis ──
  "wikipedia.org": "reference_wiki",
  "wikimedia.org": "reference_wiki",
  "wikidata.org": "reference_wiki",
  "wiktionary.org": "reference_wiki",
  "wikihow.com": "reference_wiki",
  "fandom.com": "reference_wiki",
  "britannica.com": "reference_wiki",
  "investopedia.com": "reference_wiki",
  "merriam-webster.com": "reference_wiki",
  "dictionary.com": "reference_wiki",
  "dictionary.cambridge.org": "reference_wiki",
  "whatis.techtarget.com": "reference_wiki",
  "developer.mozilla.org": "reference_wiki",
  "w3schools.com": "reference_wiki",
  "techopedia.com": "reference_wiki",
  "schema.org": "reference_wiki",
  "ietf.org": "reference_wiki",
  "rfc-editor.org": "reference_wiki",
  "w3.org": "reference_wiki",
  // ── publishers and media ──
  "forbes.com": "publisher_editorial",
  "techcrunch.com": "publisher_editorial",
  "theverge.com": "publisher_editorial",
  "wired.com": "publisher_editorial",
  "zdnet.com": "publisher_editorial",
  "cnet.com": "publisher_editorial",
  "venturebeat.com": "publisher_editorial",
  "businessinsider.com": "publisher_editorial",
  "nytimes.com": "publisher_editorial",
  "wsj.com": "publisher_editorial",
  "bloomberg.com": "publisher_editorial",
  "reuters.com": "publisher_editorial",
  "ft.com": "publisher_editorial",
  "theguardian.com": "publisher_editorial",
  "bbc.com": "publisher_editorial",
  "bbc.co.uk": "publisher_editorial",
  "cnbc.com": "publisher_editorial",
  "fortune.com": "publisher_editorial",
  "inc.com": "publisher_editorial",
  "entrepreneur.com": "publisher_editorial",
  "fastcompany.com": "publisher_editorial",
  "hbr.org": "publisher_editorial",
  "axios.com": "publisher_editorial",
  "theinformation.com": "publisher_editorial",
  "techradar.com": "publisher_editorial",
  "pcmag.com": "publisher_editorial",
  "arstechnica.com": "publisher_editorial",
  "engadget.com": "publisher_editorial",
  "mashable.com": "publisher_editorial",
  "infoworld.com": "publisher_editorial",
  "computerworld.com": "publisher_editorial",
  "cio.com": "publisher_editorial",
  "csoonline.com": "publisher_editorial",
  "networkworld.com": "publisher_editorial",
  "techtarget.com": "publisher_editorial",
  "informationweek.com": "publisher_editorial",
  "siliconangle.com": "publisher_editorial",
  "thenextweb.com": "publisher_editorial",
  "techrepublic.com": "publisher_editorial",
  "theregister.com": "publisher_editorial",
  "geekwire.com": "publisher_editorial",
  "thenewstack.io": "publisher_editorial",
  "darkreading.com": "publisher_editorial",
  "securityweek.com": "publisher_editorial",
  "bleepingcomputer.com": "publisher_editorial",
  "helpnetsecurity.com": "publisher_editorial",
  "scmagazine.com": "publisher_editorial",
  "searchengineland.com": "publisher_editorial",
  "searchenginejournal.com": "publisher_editorial",
  "medium.com": "publisher_editorial",
  "substack.com": "publisher_editorial",
  "hackernoon.com": "publisher_editorial",
  "smashingmagazine.com": "publisher_editorial",
  "css-tricks.com": "publisher_editorial",
  "usatoday.com": "publisher_editorial",
  "washingtonpost.com": "publisher_editorial",
  "cnn.com": "publisher_editorial",
  "apnews.com": "publisher_editorial",
  "economist.com": "publisher_editorial",
  "time.com": "publisher_editorial",
  "newsweek.com": "publisher_editorial",
  "marketwatch.com": "publisher_editorial",
  "yahoo.com": "publisher_editorial",
  "msn.com": "publisher_editorial",
  "businessnewsdaily.com": "publisher_editorial",
  "lifewire.com": "publisher_editorial",
  "digitaltrends.com": "publisher_editorial",
  "tomsguide.com": "publisher_editorial",
  "tomshardware.com": "publisher_editorial",
  "makeuseof.com": "publisher_editorial",
  "howtogeek.com": "publisher_editorial",
  "nerdwallet.com": "publisher_editorial",
  "bankrate.com": "publisher_editorial",
  "healthline.com": "publisher_editorial",
  "webmd.com": "publisher_editorial",
  "prnewswire.com": "publisher_editorial",
  "businesswire.com": "publisher_editorial",
  "globenewswire.com": "publisher_editorial",
  // ── analysts ──
  "gartner.com": "analyst",
  "forrester.com": "analyst",
  "idc.com": "analyst",
  "mckinsey.com": "analyst",
  "bcg.com": "analyst",
  "bain.com": "analyst",
  "deloitte.com": "analyst",
  "statista.com": "analyst",
  "cbinsights.com": "analyst",
  "everestgrp.com": "analyst",
  "omdia.com": "analyst",
  "nucleusresearch.com": "analyst",
  "hfsresearch.com": "analyst",
  "isg-one.com": "analyst",
  "frost.com": "analyst",
  "pewresearch.org": "analyst",
  "emarketer.com": "analyst",
  // ── marketplaces ──
  "appexchange.salesforce.com": "partner_marketplace",
  "marketplace.atlassian.com": "partner_marketplace",
  "apps.shopify.com": "partner_marketplace",
  "ecosystem.hubspot.com": "partner_marketplace",
  "appsource.microsoft.com": "partner_marketplace",
  "azuremarketplace.microsoft.com": "partner_marketplace",
  "marketplace.microsoft.com": "partner_marketplace",
  "apps.apple.com": "partner_marketplace",
  "play.google.com": "partner_marketplace",
  "chromewebstore.google.com": "partner_marketplace",
  "marketplace.visualstudio.com": "partner_marketplace",
  "marketplace.zoom.us": "partner_marketplace",
  "marketplace.digitalocean.com": "partner_marketplace",
  "appsumo.com": "partner_marketplace",
  // ── directories ──
  "crunchbase.com": "directory",
  "zoominfo.com": "directory",
  "yellowpages.com": "directory",
  "manta.com": "directory",
  "dnb.com": "directory",
  "owler.com": "directory",
  "pitchbook.com": "directory",
  "wellfound.com": "directory",
  "angel.co": "directory",
  "builtwith.com": "directory",
  "similarweb.com": "directory",
  "stackshare.io": "directory",
  "producthunt.com": "directory",
  "alternativeto.net": "directory",
  "saashub.com": "directory",
  "tracxn.com": "directory",
  "craft.co": "directory",
  "rocketreach.co": "directory",
  "themanifest.com": "directory",
  "designrush.com": "directory",
  "upcity.com": "directory",
  "sortlist.com": "directory",
  "betalist.com": "directory",
  "f6s.com": "directory",
  "ycombinator.com": "directory",
  "indeed.com": "directory",
  "theorg.com": "directory",
  // ── other vendors (a customer who competes with one names it; that wins) ──
  "microsoft.com": "vendor_other",
  "google.com": "vendor_other",
  "apple.com": "vendor_other",
  "aws.amazon.com": "vendor_other",
  "ibm.com": "vendor_other",
  "oracle.com": "vendor_other",
  "sap.com": "vendor_other",
  "salesforce.com": "vendor_other",
  "adobe.com": "vendor_other",
  "cisco.com": "vendor_other",
  "cloudflare.com": "vendor_other",
  "atlassian.com": "vendor_other",
  "hubspot.com": "vendor_other",
  "zapier.com": "vendor_other",
  "shopify.com": "vendor_other",
  "stripe.com": "vendor_other",
  "twilio.com": "vendor_other",
  "mozilla.org": "vendor_other",
  "intuit.com": "vendor_other",
  "servicenow.com": "vendor_other",
  "workday.com": "vendor_other",
  "zendesk.com": "vendor_other",
  "slack.com": "vendor_other",
  "dropbox.com": "vendor_other",
  "zoom.us": "vendor_other",
  "docker.com": "vendor_other",
  "digitalocean.com": "vendor_other",
  "vercel.com": "vendor_other",
  "netlify.com": "vendor_other",
  "wordpress.org": "vendor_other",
};

// ── domains ─────────────────────────────────────────────────────────────────

/** A hostname as the catalogue keys it: lower case, no scheme, path, port, `www.` or trailing dot. Same rule as measure.normalize_domain(). */
export function normalizeDomain(input: string): string {
  const host = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0] ?? "";
  return host.replace(/:\d+$/, "").replace(/^www\.|\.$/g, "");
}

const DOMAIN_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A normalised hostname with at least two labels; what the catalogue, overrides and entity domains accept. */
export function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && DOMAIN_SHAPE.test(domain) && !domain.startsWith("www.");
}

/** `a.b.example.com` → its suffixes of two labels or more, longest first: what a listed domain can match. */
export function domainSuffixes(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

// ── classification ──────────────────────────────────────────────────────────

/**
 * Everything classifySource needs for one site beyond the seed. A writer
 * loads it in the transaction that writes the citations
 * (loadSourceRoleContext), so it is never older than the rows it classifies.
 */
export interface SourceRoleContext {
  /** The site's own hostnames, www-stripped (SiteOwnership.domains). */
  owned: readonly string[];
  /** This site's overrides, by domain. */
  overrides: Readonly<Record<string, SourceRole>>;
  /** Every domain of the org's competitor entities → the entity (the earliest, when two claim one). */
  competitors: Readonly<Record<string, string>>;
  /** Catalogue rows a person or a classifier added or changed since the seed; they win over SEED_SOURCE_ROLES. */
  catalogue: Readonly<Record<string, SourceRole>>;
}

/** A context with nothing loaded but the site's domains: the seed still classifies. */
export function sourceRoleContext(owned: readonly string[] = []): SourceRoleContext {
  return { owned, overrides: {}, competitors: {}, catalogue: {} };
}

const lookup = <T>(rec: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

export interface SourceClassification {
  role: SourceRole;
  /** The competitor entity the domain belongs to; null for every other role. */
  entityId: string | null;
}

/** The role of one cited domain for one site. Pure; see the module comment for the precedence. */
export function classifySource(domain: string, ctx: SourceRoleContext): SourceClassification {
  const d = normalizeDomain(domain);
  if (!d) return { role: "unknown", entityId: null };
  if (ctx.owned.some((o) => d === o || d.endsWith(`.${o}`))) return { role: "owned", entityId: null };
  const suffixes = domainSuffixes(d);
  for (const s of suffixes) {
    const role = lookup(ctx.overrides, s);
    if (role) return { role, entityId: null };
  }
  for (const s of suffixes) {
    const entityId = lookup(ctx.competitors, s);
    if (entityId) return { role: "competitor", entityId };
  }
  for (const s of suffixes) {
    const role = lookup(ctx.catalogue, s) ?? lookup(SEED_SOURCE_ROLES, s);
    if (role) return { role, entityId: null };
  }
  return { role: "unknown", entityId: null };
}

/**
 * Load what classifySource needs beyond the seed for one site: its
 * overrides and the catalogue rows that are no longer the seed's (one
 * query), and the org's competitor domains (another). `owned` is the
 * site's domains as loadSiteOwnership resolved them. The competitors are
 * read FOR KEY SHARE: inside a writer's transaction, none can be deleted
 * before the citations naming it are written, and saving or removing one
 * (which locks it FOR UPDATE) waits for them and then restates them.
 */
export async function loadSourceRoleContext(siteId: string, orgId: string, sql: postgres.Sql = appDb(), owned: readonly string[] = []): Promise<SourceRoleContext> {
  const listed = await sql<{ domain: string; role: SourceRole; kind: "override" | "catalogue" }[]>`
    select domain, role::text as role, 'override' as kind from measure.site_source_overrides where site_id = ${siteId} and org_id = ${orgId}
    union all
    select domain, role::text as role, 'catalogue' as kind from measure.source_domains where classified_by <> 'seed'`;
  const competitors = await sql<{ domain: string; entity_id: string }[]>`
    select d.domain, e.id as entity_id
    from context.entities e cross join lateral unnest(e.domains) as d(domain)
    where e.org_id = ${orgId} and e.type = 'competitor'
    order by e.created_at, e.id
    for key share of e`;
  const overrides: Record<string, SourceRole> = {};
  const catalogue: Record<string, SourceRole> = {};
  for (const r of listed) (r.kind === "override" ? overrides : catalogue)[r.domain] = r.role;
  const byDomain: Record<string, string> = {};
  for (const c of competitors) if (!Object.hasOwn(byDomain, c.domain)) byDomain[c.domain] = c.entity_id;
  return { owned, overrides, competitors: byDomain, catalogue };
}

// ── keeping stored roles current ────────────────────────────────────────────

/**
 * Re-derive the stored role (and competitor entity) of every non-owned
 * citation on these sites whose domain is, or is under, one of `domains`,
 * after an override or a competitor's domains changed. Runs
 * measure.classify_source() once per distinct (site, domain) (`cls` is
 * materialized; inlined, the planner calls it per joined row), so it agrees
 * with the backfill; returns the rows it changed.
 */
export async function reclassifySources(siteIds: readonly string[], domains: readonly string[], sql: postgres.Sql = appDb()): Promise<number> {
  const listed = [...new Set(domains.map(normalizeDomain).filter(isValidDomain))];
  if (siteIds.length === 0 || listed.length === 0) return 0;
  const [row] = await sql<{ n: number }[]>`
    with hit as (
      select distinct c.site_id, c.domain from measure.serp_citations c
      where c.site_id = any (${[...siteIds]}::uuid[]) and not c.is_owned
        and exists (select 1 from unnest(${listed}::text[]) as l(domain) where c.domain = l.domain or right(c.domain, length(l.domain) + 1) = '.' || l.domain)
    ), cls as materialized (
      select h.site_id, h.domain, r.role, r.entity_id from hit h cross join lateral measure.classify_source(h.site_id, h.domain) r
    ), changed as (
      update measure.serp_citations c set source_role = cls.role, entity_id = cls.entity_id
      from cls
      where c.site_id = cls.site_id and c.domain = cls.domain and not c.is_owned
        and (c.source_role is distinct from cls.role or c.entity_id is distinct from cls.entity_id)
      returning 1
    )
    select count(*)::int as n from changed`;
  return row?.n ?? 0;
}

/** Set (or, with null, clear) a site's role for one domain, and restate the citations it covers. */
export async function setSourceOverride(
  site: { id: string },
  domain: string,
  role: (typeof OVERRIDE_SOURCE_ROLES)[number] | null,
  setBy: string | null,
  sql: postgres.Sql = appDb(),
): Promise<{ domain: string; reclassified: number }> {
  const d = normalizeDomain(domain);
  if (!isValidDomain(d)) throw new SourceRoleInputError(`"${domain}" is not a domain.`);
  if (role === null) {
    await sql`delete from measure.site_source_overrides where site_id = ${site.id} and domain = ${d}`;
  } else {
    await sql`
      insert into measure.site_source_overrides (site_id, domain, role, set_by)
      values (${site.id}, ${d}, ${role}, ${setBy})
      on conflict (site_id, domain) do update set role = excluded.role, set_by = excluded.set_by, updated_at = now()`;
  }
  return { domain: d, reclassified: await reclassifySources([site.id], [d], sql) };
}

export class SourceRoleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRoleInputError";
  }
}

// ── named competitors ───────────────────────────────────────────────────────

export interface CompetitorInput {
  /** The entity to confirm or edit; absent to name a new competitor (or confirm a seeded one by its name or a domain). */
  entityId?: string | null;
  name: string;
  domains: string[];
  aliases: string[];
  /**
   * The site whose page it is saved from. Its own role for a domain this
   * save names is cleared: an override outranks a competitor, so the
   * competitor would otherwise not count there. Other sites keep theirs.
   */
  siteId?: string | null;
}

/**
 * Name a competitor, or confirm or edit one: the org's competitor entity
 * with these domains and aliases. A domain belongs to one competitor, so it
 * is taken from any other entity that had it, and an unconfirmed entity the
 * topics seeded is folded in rather than left as a duplicate. The site's own
 * domains are refused, and so is a name the brand brain already holds as
 * something else (the brand, a product, an integration…); an ordinary
 * entity (type other, including one removed as a competitor) can become
 * one. Editing an entity by id sets exactly the domains and aliases given;
 * naming one that already exists adds to what it had. The domains a save
 * names are every one given when adding and the new ones when editing; the
 * saving site's overrides of exactly those are cleared (`clearedOverrides`).
 * Citations on every site of the org are restated for the domains that moved.
 */
export async function saveCompetitor(
  org: { id: string },
  input: CompetitorInput,
  actorUserId: string | null,
  sql: postgres.Sql = appDb(),
): Promise<{ entityId: string; reclassified: number; clearedOverrides: string[] }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) throw new SourceRoleInputError("Give the competitor a name.");
  const given = [...new Set(input.domains.map(normalizeDomain).filter(Boolean))];
  const bad = given.find((d) => !isValidDomain(d));
  if (bad) throw new SourceRoleInputError(`"${bad}" is not a domain.`);
  const givenAliases = input.aliases.map((a) => a.trim());

  const sites = await orgSites(org.id, sql);
  const owned = [...new Set(sites.flatMap((s) => s.domains.map(normalizeDomain)))];
  const ownHit = given.find((d) => owned.some((o) => d === o || d.endsWith(`.${o}`)));
  if (ownHit) throw new SourceRoleInputError(`${ownHit} is one of your own domains.`);

  return sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    type Entity = { id: string; type: string; name: string; domains: string[]; aliases: string[] | null; seeded: boolean };
    let target: Entity | undefined;
    if (input.entityId) {
      [target] = await tx<Entity[]>`
        select id, type::text as type, name, domains, aliases, metadata ? 'seeded_from' as seeded from context.entities
        where id = ${input.entityId} and org_id = ${org.id} for update`;
      if (!target) throw new SourceRoleInputError("Competitor not found.");
    } else {
      [target] = await tx<Entity[]>`
        select id, type::text as type, name, domains, aliases, metadata ? 'seeded_from' as seeded from context.entities
        where org_id = ${org.id} and (lower(name) = lower(${name}) or (type = 'competitor' and metadata ? 'seeded_from' and domains && ${given}::text[]))
        order by (lower(name) = lower(${name})) desc, created_at limit 1 for update`;
    }
    if (target && target.type !== "competitor" && target.type !== "other") throw new SourceRoleInputError(notACompetitor(target));
    if (target && target.name.toLowerCase() !== name.toLowerCase()) {
      const [clash] = await tx<{ id: string }[]>`select id from context.entities where org_id = ${org.id} and lower(name) = lower(${name}) and id <> ${target.id}`;
      if (clash) throw new SourceRoleInputError(`Another entity is already called ${name}.`);
    }
    // The add form shows nothing of an entity it lands on, so it adds; the edit form shows everything, so it sets.
    const merge = target && !input.entityId;
    const domains = merge ? [...new Set([...target!.domains, ...given])] : given;
    if (domains.length > 20) throw new SourceRoleInputError("Up to 20 domains per competitor.");
    const aliases = [...new Set([...(merge ? (target!.aliases ?? []) : []), ...givenAliases].filter((a) => a && a.toLowerCase() !== name.toLowerCase()))].slice(0, 30);
    const confirmed = { confirmed_at: new Date().toISOString(), confirmed_by: actorUserId };
    const [row] = target
      ? await tx<{ id: string }[]>`
          update context.entities set name = ${name}, type = 'competitor', domains = ${domains}::text[], aliases = ${aliases}::text[],
            metadata = (metadata - 'seeded_from' - 'removed_as_competitor_at' - 'removed_by' - 'former_domains') || ${tx.json(confirmed as never)}, updated_at = now()
          where id = ${target.id} returning id`
      : await tx<{ id: string }[]>`
          insert into context.entities (org_id, type, name, aliases, domains, metadata)
          values (${org.id}, 'competitor', ${name}, ${aliases}::text[], ${domains}::text[], ${tx.json(confirmed as never)})
          returning id`;
    const entityId = row!.id;
    // A domain names one competitor: take it from any other, and drop a seeded entity left with none.
    const losers = await tx<{ id: string; domains: string[] }[]>`
      update context.entities set domains = array(select x from unnest(domains) x where x <> all (${domains}::text[]) order by x), updated_at = now()
      where org_id = ${org.id} and id <> ${entityId} and type = 'competitor' and domains && ${domains}::text[]
      returning id, domains`;
    const emptied = losers.filter((l) => l.domains.length === 0).map((l) => l.id);
    if (emptied.length) await tx`delete from context.entities where id = any (${emptied}::uuid[]) and metadata ? 'seeded_from'`;
    const named = input.entityId ? given.filter((d) => !target!.domains.includes(d)) : given;
    const clearedOverrides =
      input.siteId && named.length
        ? (await tx<{ domain: string }[]>`
            delete from measure.site_source_overrides where site_id = ${input.siteId} and org_id = ${org.id} and domain = any (${named}::text[])
            returning domain`).map((o) => o.domain).sort()
        : [];
    const moved = [...new Set([...(target?.domains ?? []), ...domains])];
    const reclassified = await reclassifySources(sites.map((s) => s.id), moved, tx);
    return { entityId, reclassified, clearedOverrides };
  });
}

const OWN_ENTITY: Partial<Record<string, string>> = { brand: "your brand", product: "one of your products", feature: "one of your features" };

/** Why an entity of another type cannot be renamed into a competitor: changing it would rewrite the brand brain. */
function notACompetitor(e: { name: string; type: string }): string {
  const own = OWN_ENTITY[e.type];
  if (own) return `${e.name} is ${own}.`;
  return `${e.name} is in your brand brain as ${/^[aeiou]/.test(e.type) ? "an" : "a"} ${e.type}; give the competitor another name.`;
}

/**
 * "Not a competitor": an unconfirmed entity a topic seeded is deleted; one a
 * person named stays in the brand brain as an ordinary entity (type other),
 * so its aliases still resolve, with its domains moved to
 * metadata.former_domains and marked removed_as_competitor_at, which
 * upsertEntity and topic seeding respect: a re-crawl's profile or a fact
 * naming it does not make it a competitor again; the Strategy page does.
 * Either way its domains stop counting as a competitor on every site of the
 * org, and their citations are restated.
 */
export async function removeCompetitor(org: { id: string }, entityId: string, actorUserId: string | null, sql: postgres.Sql = appDb()): Promise<{ reclassified: number }> {
  const sites = await orgSites(org.id, sql);
  return sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    const [target] = await tx<{ id: string; domains: string[]; seeded: boolean }[]>`
      select id, domains, metadata ? 'seeded_from' as seeded from context.entities
      where id = ${entityId} and org_id = ${org.id} and type = 'competitor' for update`;
    if (!target) throw new SourceRoleInputError("Competitor not found.");
    if (target.seeded) await tx`delete from context.entities where id = ${target.id}`;
    else {
      const removed = { removed_as_competitor_at: new Date().toISOString(), removed_by: actorUserId, former_domains: target.domains };
      await tx`update context.entities set type = 'other', domains = '{}', metadata = metadata || ${tx.json(removed as never)}, updated_at = now() where id = ${target.id}`;
    }
    return { reclassified: await reclassifySources(sites.map((s) => s.id), target.domains, tx) };
  });
}

/** The org's sites and every hostname each answers on: a competitor is the org's, so its citations are on all of them. */
async function orgSites(orgId: string, sql: postgres.Sql): Promise<{ id: string; domains: string[] }[]> {
  return sql<{ id: string; domains: string[] }[]>`
    select s.id, array_remove(array[s.canonical_domain] || array(select sd.hostname from app.site_domains sd where sd.site_id = s.id), null) as domains
    from app.sites s where s.org_id = ${orgId}`;
}

/**
 * The domains a topic watches, as competitors (measure.seed_competitor_domains,
 * the rule migration 0022 applied to the topics that existed then): each one
 * not already a competitor's (itself or as a subdomain of one), not the
 * org's own, not named after an entity someone removed as a competitor or
 * one of another kind (the brand, a product, an integration…) and not a
 * catalogue domain other than a vendor's (a review site watched as a rival
 * stays a review site until someone names it) joins the one competitor
 * entity whose name it spells (okta.com → "Okta"), or becomes an
 * unconfirmed competitor named after the domain. `added` is what landed on
 * a competitor; citations on the org's sites are restated for it.
 */
export async function seedCompetitorsFromDomains(org: { id: string }, rawDomains: readonly string[], sql: postgres.Sql = appDb()): Promise<{ added: string[]; reclassified: number }> {
  const domains = [...new Set(rawDomains.map(normalizeDomain).filter(isValidDomain))];
  if (domains.length === 0) return { added: [], reclassified: 0 };
  const added = (await sql<{ domain: string }[]>`select domain from measure.seed_competitor_domains(${org.id}, ${domains}::text[])`).map((a) => a.domain);
  if (added.length === 0) return { added, reclassified: 0 };
  const sites = await orgSites(org.id, sql);
  return { added, reclassified: await reclassifySources(sites.map((s) => s.id), added, sql) };
}
