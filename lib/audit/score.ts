import type { AuditResult, DimensionScores } from "./types";

/**
 * Composite GEO score.
 *
 * gtm-agents weighted citability .25 / eeat .20 / platform .20 / technical .15
 * / schema .10 / crawler .10. Platform readiness is a model re-reading the
 * other five, so four dimensions were double-counted and 65% of the score was
 * model output. Here platform carries zero weight, the deterministic
 * dimensions carry 60%, and crawler access — the gate everything else sits
 * behind — is the second-largest term.
 */
export const DIMENSION_WEIGHTS: Record<keyof DimensionScores, number> = {
  citability: 0.25,
  crawlerAccess: 0.2,
  technical: 0.2,
  eeat: 0.15,
  schema: 0.15,
  llmsTxt: 0.05,
};

export function llmsTxtScore(r: AuditResult["llmsTxt"]): number | null {
  if (!r) return null;
  if (!r.found) return 0;
  if (!r.valid) return 40;
  return r.sections.length >= 3 ? 100 : 70;
}

export type AvailableDimensions = { [K in keyof DimensionScores]: number | null };

export function collectDimensions(a: Pick<AuditResult, "crawlerAccess" | "schema" | "citability" | "eeat" | "technical" | "llmsTxt">): AvailableDimensions {
  return {
    crawlerAccess: a.crawlerAccess?.totalScore ?? null,
    schema: a.schema?.totalScore ?? null,
    citability: a.citability?.averageScore ?? null,
    eeat: a.eeat?.totalScore ?? null,
    technical: a.technical?.totalScore ?? null,
    llmsTxt: llmsTxtScore(a.llmsTxt),
  };
}

/**
 * Weighted mean over the dimensions that actually ran. A degraded module
 * drops out of the denominator instead of contributing a fake zero; the
 * result carries `degraded` so the UI can say "score excludes citability".
 */
export function calculateGeoScore(dims: AvailableDimensions): { score: number; coverage: number } {
  let weighted = 0;
  let totalWeight = 0;
  for (const [k, w] of Object.entries(DIMENSION_WEIGHTS) as [keyof DimensionScores, number][]) {
    const v = dims[k];
    if (v === null || v === undefined) continue;
    weighted += Math.max(0, Math.min(100, v)) * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return { score: 0, coverage: 0 };
  return { score: Math.round(weighted / totalWeight), coverage: Math.round(totalWeight * 100) / 100 };
}
