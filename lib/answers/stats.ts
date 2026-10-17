/**
 * Intervals for the answer metrics. Every share we report is a proportion of
 * answers (k of n), and a probe panel is small: 25 prompts on one engine is
 * n = 25 a week. A bare percentage at that size reads as precise when it is
 * not, so each share carries a 95% Wilson score interval, which stays inside
 * [0, 1] and behaves at k = 0 and k = n where the normal approximation does
 * not, and the UI flags any n under LOW_N.
 */

export const LOW_N = 30;

export interface Proportion {
  k: number;
  n: number;
  /** k / n; null when n is 0. */
  p: number | null;
  low: number | null;
  high: number | null;
}

/** k of n with its Wilson score interval at `z` (1.96: 95%). Pure. */
export function wilson(k: number, n: number, z = 1.96): Proportion {
  if (!(n > 0)) return { k: 0, n: 0, p: null, low: null, high: null };
  const kk = Math.min(Math.max(k, 0), n);
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k: kk, n, p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}
