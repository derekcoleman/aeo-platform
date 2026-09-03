import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import type { EntityRow, EntityType } from "./types";

/**
 * Layer 3: entities. Resolution is by exact alias with word boundaries,
 * never by substring. "Notion" inside "notionally" is the bug that silently
 * corrupts entity coverage, mention counts and competitor spikes at once, so
 * the boundary regex is the one rule this module exists to enforce.
 */

export function normalizeAlias(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface AliasIndex {
  /** normalised alias → entity */
  byAlias: Map<string, EntityRow>;
  entities: EntityRow[];
}

export function buildAliasIndex(entities: EntityRow[]): AliasIndex {
  const byAlias = new Map<string, EntityRow>();
  for (const e of entities) {
    for (const a of [e.name, ...e.aliases]) {
      const key = normalizeAlias(a);
      // First writer wins so the canonical name outranks a later alias collision.
      if (key && !byAlias.has(key)) byAlias.set(key, e);
    }
  }
  return { byAlias, entities };
}

/** Exact (normalised) name or alias match only. */
export function resolveEntityByName(index: AliasIndex, name: string): EntityRow | null {
  return index.byAlias.get(normalizeAlias(name)) ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface EntityMention {
  entity: EntityRow;
  alias: string;
  count: number;
}

/**
 * Every entity whose name or an alias appears in `text` as a whole word
 * (letters/digits on either side break the match). Case-insensitive,
 * Unicode-aware; an alias shorter than two characters is ignored.
 */
export function findEntityMentions(index: AliasIndex, text: string): EntityMention[] {
  const out = new Map<string, EntityMention>();
  // Longest alias first, and a span claimed by one alias is not re-counted by
  // a shorter one ("Okta Workforce" is one mention of Okta, not two).
  const taken: [number, number][] = [];
  const aliases = [...index.byAlias.entries()].filter(([a]) => a.length >= 2).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, entity] of aliases) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(alias).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
    let count = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      count++;
    }
    if (count === 0) continue;
    const cur = out.get(entity.id);
    if (cur) cur.count += count;
    else out.set(entity.id, { entity, alias, count });
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

// ── persistence ─────────────────────────────────────────────────────────────


export async function listEntities(orgId: string, sql: postgres.Sql = appDb(), types?: EntityType[]): Promise<EntityRow[]> {
  return types?.length
    ? sql<EntityRow[]>`select id, org_id, type, name, aliases, wikidata_id, description from context.entities where org_id = ${orgId} and type = any(${sql.array(types)}::context.entity_type[]) order by name`
    : sql<EntityRow[]>`select id, org_id, type, name, aliases, wikidata_id, description from context.entities where org_id = ${orgId} order by name`;
}

export interface EntityInput {
  type: EntityType;
  name: string;
  aliases?: string[];
  wikidataId?: string | null;
  description?: string | null;
}

/** Insert by (org, lower(name)); on conflict merge aliases and fill blanks, never demote a type someone set. */
export async function upsertEntity(orgId: string, input: EntityInput, sql: postgres.Sql = appDb()): Promise<EntityRow> {
  const name = input.name.trim();
  const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter((a) => a && normalizeAlias(a) !== normalizeAlias(name)))];
  const [row] = await sql<EntityRow[]>`
    insert into context.entities (org_id, type, name, aliases, wikidata_id, description)
    values (${orgId}, ${input.type}, ${name}, ${sql.array(aliases)}, ${input.wikidataId ?? null}, ${input.description ?? null})
    on conflict (org_id, lower(name)) do update
      set aliases = (select array_agg(distinct a) from unnest(context.entities.aliases || excluded.aliases) as a),
          type = case when context.entities.type = 'other' then excluded.type else context.entities.type end,
          wikidata_id = coalesce(context.entities.wikidata_id, excluded.wikidata_id),
          description = coalesce(context.entities.description, excluded.description),
          updated_at = now()
    returning id, org_id, type, name, aliases, wikidata_id, description`;
  if (!row) throw new Error("entity upsert returned no row");
  return { ...row, aliases: row.aliases ?? [] };
}

/** The org's brand entity, created from the site's organisation name / domain when missing. */
export async function ensureBrandEntity(orgId: string, siteId: string | null, sql: postgres.Sql = appDb()): Promise<EntityRow> {
  const [existing] = await sql<EntityRow[]>`select id, org_id, type, name, aliases, wikidata_id, description from context.entities where org_id = ${orgId} and type = 'brand' order by created_at limit 1`;
  if (existing) return existing;
  const [site] = siteId
    ? await sql<{ canonical_domain: string; name: string | null }[]>`
        select s.canonical_domain, coalesce(c.organization->>'name', s.name) as name
        from app.sites s left join content.site_render_config c on c.site_id = s.id where s.id = ${siteId} and s.org_id = ${orgId}`
    : [];
  const [org] = await sql<{ name: string }[]>`select name from app.organizations where id = ${orgId}`;
  const name = site?.name ?? org?.name ?? "Brand";
  const aliases = site ? [site.canonical_domain, site.canonical_domain.replace(/^www\./, "")] : [];
  return upsertEntity(orgId, { type: "brand", name, aliases }, sql);
}
