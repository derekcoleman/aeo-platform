import type { EntityRow } from "@/lib/context/types";
import type { BusinessProfile } from "@/lib/onboarding/profile";

/**
 * The seed terms demand mining starts from, in the order a buyer would
 * search: what the operator chose to track (topics and their seed terms),
 * the keywords entered at onboarding, the category terms the website crawl
 * suggested, then category entities, and finally competitors phrased as the
 * "<competitor> alternative" query. Our own brand and product names are
 * excluded: branded queries measure people who already know us, not the
 * demand we want to win.
 */
export interface SeedInput {
  siteName?: string | null;
  keywords?: string[];
  profile?: Pick<BusinessProfile, "name" | "keywords" | "products"> | null;
  topics?: { name: string; seed_terms: string[] }[];
  entities?: Pick<EntityRow, "type" | "name" | "aliases">[];
}

export const MAX_SEEDS = 30;
const MAX_COMPETITOR_SEEDS = 5;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function demandSeeds(input: SeedInput, max = MAX_SEEDS): string[] {
  const branded = new Set<string>();
  const addBranded = (s: string | null | undefined) => {
    const n = norm(s ?? "");
    if (n.length >= 2) branded.add(n);
  };
  addBranded(input.siteName);
  addBranded(input.profile?.name);
  for (const p of input.profile?.products ?? []) addBranded(p.name);
  for (const e of input.entities ?? []) {
    if (e.type === "brand" || e.type === "product") {
      addBranded(e.name);
      for (const a of e.aliases) addBranded(a);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const s = raw.replace(/\s+/g, " ").trim();
    const n = norm(s);
    if (n.length < 2 || seen.has(n) || branded.has(n)) return;
    seen.add(n);
    out.push(s);
  };

  for (const t of input.topics ?? []) {
    push(t.name);
    for (const s of t.seed_terms) push(s);
  }
  for (const k of input.keywords ?? []) push(k);
  for (const k of input.profile?.keywords ?? []) push(k);
  for (const e of input.entities ?? []) if (e.type === "category") push(e.name);

  const competitors = new Set<string>();
  for (const e of input.entities ?? []) if (e.type === "competitor") competitors.add(e.name.trim());
  let added = 0;
  for (const c of competitors) {
    if (added >= MAX_COMPETITOR_SEEDS) break;
    const before = out.length;
    push(`${c} alternative`);
    if (out.length > before) added++;
  }

  return out.slice(0, max);
}

/** The (country, language) pair demand mining uses for a site, from its BCP-47 locale ("en-US" → us/en). */
export function mineLocale(locale: string | null | undefined): { country: string; language: string } {
  const [language = "en", country = "us"] = (locale || "en-US").split(/[-_]/).map((s) => s.toLowerCase());
  return { country: country.slice(0, 2), language: language.slice(0, 2) };
}
