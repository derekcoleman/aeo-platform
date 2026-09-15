/**
 * Refresh prioritisation. Pure: the same signals always give the same score
 * and the same reasons, and the breakdown is stored next to the score so the
 * number is arguable rather than magic (the same contract as opportunities).
 *
 * Signals come from three places, each attributed:
 *  - the CMS itself: when the item was last modified, its size;
 *  - Search Console: clicks / impressions / position, this window vs the
 *    previous one (demand for the page, and whether it is decaying);
 *  - AI citations: how often the URL was cited in the last 30 days versus the
 *    30 before, from our own trackers and — labelled separately — Profound.
 */

export interface RefreshSignals {
  /** Days since the CMS item was last modified (null when the CMS gave no date). */
  ageDays: number | null;
  wordCount: number;
  headingCount: number;
  gsc: {
    available: boolean;
    clicks: number;
    clicksPrev: number;
    impressions: number;
    impressionsPrev: number;
    /** Average position in the current window; null without data. */
    position: number | null;
  };
  citations: {
    /** Distinct questions / prompts this URL was cited on in the last 30 days, by source. */
    native: number;
    nativePrev: number;
    profound: number;
    profoundPrev: number;
    /** Whether any tracker has snapshots for this site at all — no data is not the same as zero citations. */
    nativeAvailable: boolean;
    profoundAvailable: boolean;
  };
}

export const REFRESH_WEIGHTS = { staleness: 0.25, demand: 0.25, decline: 0.2, citationGap: 0.2, thinness: 0.1 } as const;
export type RefreshFactor = keyof typeof REFRESH_WEIGHTS;

export interface RefreshScore {
  score: number;
  breakdown: Record<RefreshFactor, { value: number; weight: number; contribution: number }>;
  reasons: string[];
}

/** A candidate needs at least this score to open a refresh opportunity. */
export const REFRESH_THRESHOLD = 45;
/** How many candidates a scan opens per site per night; the rest are visible in the app, not queued. */
export const REFRESH_MAX_OPPORTUNITIES = 20;
/** Content this young is never a candidate: the engines have not had time to see it. */
export const REFRESH_MIN_AGE_DAYS = 45;

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const pct = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : 0);

/** Demand on a log scale: 100 impressions ≈ 50, 10k ≈ 100. */
export function demandFromImpressions(impressions: number): number {
  if (impressions <= 0) return 0;
  return clamp((Math.log10(1 + impressions) / 4) * 100);
}

export function scoreRefresh(s: RefreshSignals): RefreshScore {
  const reasons: string[] = [];

  // Staleness: 0 at fresh, 100 at a year or more. Unknown age counts as a year old.
  const age = s.ageDays ?? 365;
  const staleness = clamp((age / 365) * 100);
  if (age >= 365) reasons.push(`Not updated in ${Math.floor(age / 30)} months`);
  else if (age >= 180) reasons.push(`Not updated in ${Math.floor(age / 30)} months`);

  // Demand: pages people already search for are worth refreshing; a page nobody sees is a different problem.
  const demand = s.gsc.available ? demandFromImpressions(s.gsc.impressions) : 50;
  if (s.gsc.available && s.gsc.impressions >= 100) reasons.push(`${fmt(s.gsc.impressions)} impressions / 28d`);

  // Decline: clicks or impressions down versus the previous window. Needs a base to compare against.
  let decline = 0;
  if (s.gsc.available) {
    const clickDrop = s.gsc.clicksPrev >= 10 ? -pct(s.gsc.clicks, s.gsc.clicksPrev) : 0;
    const imprDrop = s.gsc.impressionsPrev >= 100 ? -pct(s.gsc.impressions, s.gsc.impressionsPrev) : 0;
    decline = clamp(Math.max(clickDrop, imprDrop) * 2); // a 50% drop is the ceiling
    if (clickDrop >= 20) reasons.push(`Clicks down ${clickDrop}% vs previous 28d`);
    else if (imprDrop >= 20) reasons.push(`Impressions down ${imprDrop}% vs previous 28d`);
  }

  // Citation gap: demand without citations, or citations lost. Profound counts when native has nothing to say.
  const cited = s.citations.native + s.citations.profound;
  const citedPrev = s.citations.nativePrev + s.citations.profoundPrev;
  const anyTracker = s.citations.nativeAvailable || s.citations.profoundAvailable;
  let citationGap = 50;
  if (anyTracker) {
    if (cited === 0 && citedPrev > 0) {
      citationGap = 90;
      reasons.push(`Lost all ${citedPrev} AI citation${citedPrev === 1 ? "" : "s"} it had`);
    } else if (cited < citedPrev) {
      citationGap = 70;
      reasons.push(`AI citations down ${citedPrev} → ${cited}`);
    } else if (cited === 0 && s.gsc.available && s.gsc.impressions >= 100) {
      citationGap = 80;
      reasons.push("Search demand but no AI citations");
    } else if (cited === 0) {
      citationGap = 40;
    } else {
      citationGap = 0; // it is being cited and holding; do not disturb
    }
  }

  // Thinness: short bodies rarely earn a citation; a long one that is not cited has other problems.
  const thinness = s.wordCount === 0 ? 50 : s.wordCount < 400 ? 80 : s.wordCount < 800 ? 40 : 0;
  if (s.wordCount > 0 && s.wordCount < 400) reasons.push(`Only ${s.wordCount} words`);

  const values: Record<RefreshFactor, number> = { staleness, demand, decline, citationGap, thinness };
  const breakdown = {} as RefreshScore["breakdown"];
  let score = 0;
  for (const key of Object.keys(REFRESH_WEIGHTS) as RefreshFactor[]) {
    const weight = REFRESH_WEIGHTS[key];
    const contribution = Math.round(values[key] * weight * 100) / 100;
    breakdown[key] = { value: Math.round(values[key] * 100) / 100, weight, contribution };
    score += contribution;
  }
  return { score: Math.round(score * 100) / 100, breakdown, reasons };
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n));
}

export interface CandidateInput {
  isDraft: boolean;
  isArchived: boolean;
  missing: boolean;
  hasBody: boolean;
  ageDays: number | null;
  /** A refresh already queued or running for this item. */
  inFlight: boolean;
}

/** Why an item is not a candidate, or null when it is. */
export function candidateExclusion(c: CandidateInput): string | null {
  if (c.missing) return "deleted in the CMS";
  if (c.isArchived) return "archived";
  if (c.isDraft) return "draft";
  if (!c.hasBody) return "no rich-text body";
  if (c.ageDays !== null && c.ageDays < REFRESH_MIN_AGE_DAYS) return `updated ${c.ageDays}d ago`;
  if (c.inFlight) return "refresh in progress";
  return null;
}
