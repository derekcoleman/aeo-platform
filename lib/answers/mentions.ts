import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { buildAliasIndex, findEntityMentions, listEntities, type AliasIndex } from "@/lib/context/entities";
import type { EntityType } from "@/lib/context/types";

/**
 * Who an AI answer mentions, lists and recommends: the brand (and its
 * products) and the org's named competitors, matched by name or alias as
 * whole words (findEntityMentions; "Notion" inside "notionally" never
 * counts). Deterministic and cheap, so every probe is read the same way; a
 * judge for sentiment and claim accuracy comes later and leaves its own
 * version on the row.
 *
 * - list rank: answers to "best X for Y" are mostly lists. Each numbered
 *   ("1.", "1)", "**1.**") or bulleted line is an item, and an item names
 *   the entity it mentions first. Numbered items keep their number; bullets
 *   count from 1 within their list (a heading or a paragraph at the margin
 *   starts a new one, and each item starts its own nested list). A numbered
 *   heading ("### 1. Acme") is an item; an unnumbered one is only in a run
 *   of sibling headings that each name a single entity, two entities or more
 *   ("### Okta", "### JumpCloud"). A title ranks nothing, whatever it names:
 *   "## Best Okta alternatives" does not put Okta first, nor "## Acme vs
 *   Okta" Acme. What sits under an item that names an entity (its nested
 *   bullets, its heading's section) is detail about that entity and ranks
 *   nothing: "Cheaper than Okta" under "1. Acme" does not list Okta. An
 *   entity's rank is that of the first item naming it.
 * - recommended: first in a top-level list (rank 1 and not nested in another
 *   item), or named in a sentence that recommends ("recommend", "best
 *   choice", "top pick", "go with", "ideal for", "stands out"…) with no
 *   negation in the three words before the cue ("I would not recommend",
 *   "avoid"). Every entity in such a sentence counts: v0 does not work out
 *   which of them the cue is about.
 */

export const MENTION_EXTRACTOR_VERSION = "mentions-v0";

/** The entities an answer is read for. */
export const MENTION_ENTITY_TYPES: EntityType[] = ["brand", "product", "competitor"];
const BRAND_TYPES = new Set<EntityType>(["brand", "product"]);

export interface AnswerMention {
  entityId: string;
  name: string;
  type: EntityType;
  /** The brand or one of its products. */
  isBrand: boolean;
  matchedAlias: string;
  mentionCount: number;
  firstOffset: number;
  listRank: number | null;
  isListed: boolean;
  isRecommended: boolean;
}

export interface ListItem {
  rank: number;
  /** Offset of the item's line in the answer. */
  start: number;
  /** The item's text, marker removed. */
  text: string;
  /** A heading's level, 1–6; 0 for a numbered or bulleted line. */
  level: number;
  /** Numbered ("1.", "1)", "**1.**"), as a line or a heading. */
  numbered: boolean;
  /** How many list items this one is nested in: 0 at its list's margin, and for a heading. */
  depth: number;
  /**
   * What it sits under, as an index into the items: the list item it is
   * nested in, else its section's heading (for a heading, the heading above
   * its level). Null at the top.
   */
  parent: number | null;
}

const HEADING = /^\s*(#{1,6})\s+(?:(?:\*\*|__)?(\d{1,3})[.)](?:\*\*|__)?\s+)?(.*)$/;
const NUMBERED = /^(\s*)(?:\*\*|__)?(\d{1,3})[.)](?:\*\*|__)?\s+(.*)$/;
const BULLET = /^(\s*)[-*•+]\s+(.*)$/;

/** The list items and headings of an answer, in order, with their rank and where each sits. Pure. */
export function listItems(text: string): ListItem[] {
  const items: ListItem[] = [];
  // The headings whose sections are open and the list items open above this line, outermost first.
  const sections: number[] = [];
  let open: { indent: number; index: number }[] = [];
  // Bullets so far per list, parent and indent; unnumbered headings so far per parent and level.
  const counts = new Map<string, number>();
  const next = (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
  let list = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    const heading = HEADING.exec(line);
    const numbered = heading ? null : NUMBERED.exec(line);
    const bullet = heading || numbered ? null : BULLET.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (sections.length && items[sections.at(-1)!]!.level >= level) sections.pop();
      const parent = sections.at(-1) ?? null;
      // A heading opens a section: the lists above it end.
      open = [];
      list += 1;
      sections.push(items.length);
      items.push({ rank: heading[2] ? Number(heading[2]) : next(`h:${parent}:${level}`), start, text: heading[3]!, level, numbered: !!heading[2], depth: 0, parent });
    } else if (numbered || bullet) {
      const indent = (numbered ?? bullet)![1]!.length;
      // Close what this item is not nested in: deeper items, and a sibling at
      // its indent. A bullet at a numbered item's indent is that item's
      // detail, as answers often write them.
      while (open.length) {
        const top = open.at(-1)!;
        if (top.indent < indent || (top.indent === indent && bullet && items[top.index]!.numbered)) break;
        open.pop();
      }
      const parent = open.at(-1)?.index ?? sections.at(-1) ?? null;
      const rank = numbered ? Number(numbered[2]) : next(`${list}:${parent}:${indent}`);
      items.push({ rank, start, text: (numbered ? numbered[3] : bullet![2])!, level: 0, numbered: !!numbered, depth: open.length, parent });
      open.push({ indent, index: items.length - 1 });
    } else if (!/^\s/.test(line)) {
      // A paragraph at the margin ends the lists above it.
      open = [];
      list += 1;
    }
  }
  return items;
}

interface Ranking {
  entityId: string;
  rank: number;
  /** First-level: a heading, or a list item not nested in another. */
  top: boolean;
}

/** The items that rank an entity, in order, each with the entity it names first (see the header). Pure. */
function rankings(items: ListItem[], index: AliasIndex): Ranking[] {
  const named = items.map((i) => findEntityMentions(index, i.text).sort((a, b) => a.firstIndex - b.firstIndex).map((m) => m.entity.id));
  // Unnumbered headings rank in a run of siblings that each name one entity, two entities or more; by place in the run.
  const runRank = new Map<number, number>();
  const siblings = new Map<string, number[]>();
  items.forEach((it, i) => {
    if (!it.level || it.numbered) return;
    const key = `${it.parent}:${it.level}`;
    siblings.set(key, [...(siblings.get(key) ?? []), i]);
  });
  for (const group of siblings.values()) {
    let run: number[] = [];
    const close = () => {
      if (new Set(run.map((i) => named[i]![0])).size >= 2) run.forEach((i, n) => runRank.set(i, n + 1));
      run = [];
    };
    for (const i of group) {
      if (named[i]!.length === 1) run.push(i);
      else close();
    }
    close();
  }
  const out: Ranking[] = [];
  // An item that ranks an entity, or sits under one that does: what is under it is detail.
  const held: boolean[] = [];
  items.forEach((it, i) => {
    const detail = it.parent !== null && held[it.parent]!;
    const rank = it.level && !it.numbered ? (runRank.get(i) ?? 0) : it.rank;
    const ranks = !detail && rank >= 1 && named[i]!.length > 0;
    if (ranks) out.push({ entityId: named[i]![0]!, rank, top: it.depth === 0 });
    held.push(detail || ranks);
  });
  return out;
}

const CUE = /\b(?:recommend\w*|best (?:choice|option|overall|pick)|top (?:pick|choice)|go with|(?:we|i) (?:would )?suggest|ideal for|stands? out)\b/gi;
const NEGATION = /^(?:not|never|avoid|no|cannot)$|n't$/i;

/** The sentence recommends something: a cue with no negation among the three words before it. Pure. */
export function recommends(sentence: string): boolean {
  for (const m of sentence.matchAll(CUE)) {
    const before = sentence
      .slice(0, m.index)
      .split(/\s+/)
      .map((w) => w.replace(/’/g, "'").replace(/[^\p{L}\p{N}']/gu, ""))
      .filter(Boolean)
      .slice(-3);
    if (!before.some((w) => NEGATION.test(w))) return true;
  }
  return false;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim());
}

/** Every brand, product and named competitor the answer mentions, earliest first. Pure. */
export function extractMentions(text: string, index: AliasIndex): AnswerMention[] {
  const found = findEntityMentions(index, text);
  if (found.length === 0) return [];
  const ranks = new Map<string, number>();
  const recommended = new Set<string>();
  for (const r of rankings(listItems(text), index)) {
    if (!ranks.has(r.entityId)) ranks.set(r.entityId, r.rank);
    // First in a top-level list.
    if (r.rank === 1 && r.top) recommended.add(r.entityId);
  }
  for (const s of sentences(text)) {
    if (!recommends(s)) continue;
    for (const m of findEntityMentions(index, s)) recommended.add(m.entity.id);
  }
  return found
    .map((m) => {
      const listRank = ranks.get(m.entity.id) ?? null;
      return {
        entityId: m.entity.id,
        name: m.entity.name,
        type: m.entity.type,
        isBrand: BRAND_TYPES.has(m.entity.type),
        matchedAlias: m.alias,
        mentionCount: m.count,
        firstOffset: m.firstIndex,
        listRank,
        isListed: listRank !== null,
        isRecommended: recommended.has(m.entity.id),
      };
    })
    .sort((a, b) => a.firstOffset - b.firstOffset);
}

/** The org's brand, products and competitors as an alias index, for extractMentions. */
export async function loadMentionIndex(orgId: string, sql: postgres.Sql = appDb()): Promise<AliasIndex> {
  return buildAliasIndex(await listEntities(orgId, sql, MENTION_ENTITY_TYPES));
}
