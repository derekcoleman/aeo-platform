import type postgres from "postgres";
import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { ensureBrandEntity, upsertEntity } from "@/lib/context/entities";
import type { CrawledPage } from "@/lib/crawl/site";
import { appDb } from "@/lib/db/app";
import { runJsonTask } from "@/lib/pipeline/model";
import type { ModelRun } from "@/lib/pipeline/types";
import { createTopic, listTopics, topicInputSchema } from "@/lib/strategy/topics";

/**
 * The business profile: what the company is, in the shape the rest of the
 * product needs. Extracted once from the website crawl, editable later,
 * and the source of the first entities (brand, products, competitors) and
 * the keyword suggestions the Strategy page turns into topics.
 */
const dedupe = (items: string[]): string[] => {
  const seen = new Set<string>();
  return items.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const asText = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\s+/g, " ").trim();

/** A string the model must supply, clipped to `max` characters rather than rejected. */
const required = (max: number) => z.unknown().transform(asText).pipe(z.string().min(1)).transform((s) => s.slice(0, max));
/** An optional string; empty or missing becomes "" (or null when `nullable`), long values are clipped. */
const optional = (max: number) => z.unknown().optional().transform((v) => asText(v).slice(0, max));
const optionalOrNull = (max: number) => z.unknown().optional().transform((v) => asText(v).slice(0, max) || null);
/** A list of short strings: non-strings and too-short items dropped, long items clipped, deduped, capped. */
const list = (max: number, itemMax: number, itemMin = 1) =>
  z.unknown().optional().transform((v) => (Array.isArray(v) ? dedupe(v.map(asText).map((s) => s.slice(0, itemMax)).filter((s) => s.length >= itemMin)).slice(0, max) : []));

/**
 * Model output is data, so length limits clip instead of failing the run:
 * one over-long `pricingModel` must never fail a whole crawl. Only `name`,
 * `oneLiner` and `category` are required.
 */
export const businessProfileSchema = z.object({
  name: required(120),
  oneLiner: required(300),
  category: required(120),
  description: optional(1500),
  products: z
    .unknown()
    .optional()
    .transform((v) =>
      Array.isArray(v)
        ? v
            .map((item) => (item && typeof item === "object" ? { name: asText((item as { name?: unknown }).name).slice(0, 120), description: asText((item as { description?: unknown }).description).slice(0, 300) } : { name: asText(item).slice(0, 120), description: "" }))
            .filter((item) => item.name.length > 0)
            .slice(0, 15)
        : [],
    ),
  audiences: list(10, 120),
  useCases: list(15, 160),
  differentiators: list(10, 200),
  competitors: list(15, 120),
  keywords: list(30, 80, 2),
  pricingModel: optionalOrNull(400),
  locations: list(10, 120),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

export const PROFILE_PROMPT_VERSION = "site.profile.v1";

const SYSTEM = `You extract a factual business profile from pages of a company's own website.
Rules: use only what the pages say; never invent products, customers or competitors; when a field is not supported by the pages, leave it empty.
"keywords" are the topics a buyer would search or ask an AI assistant about that this company should be known for: 8 to 25 short noun phrases, specific to the category (not the brand name, not generic words like "software").
"competitors" are named only if the site itself names or compares against them.
Return one JSON object with exactly these keys: name, oneLiner, category, description, products (array of {name, description}), audiences, useCases, differentiators, competitors, keywords, pricingModel (string or null), locations.`;

/** Build the extraction prompt from crawled pages, most informative first, within a character budget. */
export function profilePrompt(pages: CrawledPage[], site: { domain: string; name: string }, budget = 60_000): string {
  const order: Record<string, number> = { home: 0, about: 1, pricing: 2, product: 3, solutions: 4, customers: 5, integrations: 6, compare: 7, faq: 8, docs: 9, blog: 10, other: 11, legal: 12 };
  const sorted = [...pages].sort((a, b) => (order[a.kind] ?? 99) - (order[b.kind] ?? 99));
  const parts: string[] = [`Website: https://${site.domain} (project name: ${site.name})`, ""];
  let used = parts.join("\n").length;
  for (const p of sorted) {
    const per = p.kind === "home" || p.kind === "about" || p.kind === "pricing" ? 12_000 : 5_000;
    const body = p.markdown.slice(0, per);
    const block = `### ${p.kind} — ${p.url}\n${p.title ? `Title: ${p.title}\n` : ""}${body}\n`;
    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length;
  }
  parts.push("Extract the business profile as JSON.");
  return parts.join("\n");
}

export async function extractBusinessProfile(
  model: TextModel,
  pages: CrawledPage[],
  site: { domain: string; name: string },
  scope: { orgId: string; siteId: string },
  sql: postgres.Sql = appDb(),
): Promise<{ profile: BusinessProfile; run: ModelRun }> {
  const { value, run } = await runJsonTask("site.profile.extract", model, { system: SYSTEM, prompt: profilePrompt(pages, site), promptVersion: PROFILE_PROMPT_VERSION, maxTokens: 4096, temperature: 0.1 }, businessProfileSchema, scope, sql);
  return { profile: value, run };
}

/** Store the profile on the site and seed the entity layer from it. Idempotent: re-running merges aliases and fills blanks. */
export async function applyBusinessProfile(site: { id: string; org_id: string; name: string }, profile: BusinessProfile, sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update app.sites set profile = ${sql.json(profile as never)}, profile_status = 'ready', profile_error = null, profile_updated_at = now() where id = ${site.id} and org_id = ${site.org_id}`;
  const brand = await ensureBrandEntity(site.org_id, site.id, sql);
  const aliases = [site.name, profile.name].filter((a) => a.trim().toLowerCase() !== brand.name.trim().toLowerCase());
  await upsertEntity(site.org_id, { type: "brand", name: brand.name, aliases, description: profile.oneLiner }, sql);
  for (const p of profile.products) await upsertEntity(site.org_id, { type: "product", name: p.name, description: p.description || null }, sql);
  for (const c of profile.competitors) await upsertEntity(site.org_id, { type: "competitor", name: c }, sql);
}

/** Split a pasted keyword list: newlines or commas, trimmed, de-duplicated case-insensitively, bounded. */
export function parseKeywords(raw: string | null | undefined, max = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of (raw ?? "").split(/[\n,;]/)) {
    const t = k.trim().replace(/\s+/g, " ");
    if (t.length < 2 || t.length > 80) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Turn keywords into topics (one each, the keyword as its seed term), skipping any that already exist by name or seed. */
export async function keywordsToTopics(siteId: string, keywords: string[], sql: postgres.Sql = appDb()): Promise<{ created: string[]; skipped: string[] }> {
  const existing = await listTopics(siteId, sql, true);
  const taken = new Set<string>();
  for (const t of existing) {
    taken.add(t.name.trim().toLowerCase());
    for (const s of t.seed_terms) taken.add(s.trim().toLowerCase());
  }
  const created: string[] = [];
  const skipped: string[] = [];
  for (const kw of keywords) {
    const key = kw.trim().toLowerCase();
    if (taken.has(key)) {
      skipped.push(kw);
      continue;
    }
    await createTopic(siteId, topicInputSchema.parse({ name: kw, seedTerms: [kw] }), sql);
    taken.add(key);
    created.push(kw);
  }
  return { created, skipped };
}
