/**
 * SERP vendor credentials, read in one place. The SerpApi key is
 * SERPAPI_API_KEY, which is what the client always read; several screens
 * checked SERPAPI_KEY instead, so a deployment could look configured and
 * fail on every call (or the reverse). SERPAPI_KEY is still honoured, with a
 * warning, so an environment set up under that name keeps working.
 *
 * A vendor counts as configured only when the client can call it:
 * DataForSEO needs its login and its password.
 */

type Env = Record<string, string | undefined>;

export type SerpVendor = "dataforseo" | "serpapi";

let warnedLegacyKey = false;

export function serpApiKey(env: Env = process.env): string | null {
  const key = env.SERPAPI_API_KEY?.trim();
  if (key) return key;
  const legacy = env.SERPAPI_KEY?.trim();
  if (!legacy) return null;
  if (!warnedLegacyKey && env.NODE_ENV !== "test") {
    warnedLegacyKey = true;
    console.warn("[serp] SERPAPI_KEY is deprecated; set SERPAPI_API_KEY instead");
  }
  return legacy;
}

export function dataForSeoConfigured(env: Env = process.env): boolean {
  return !!env.DATAFORSEO_LOGIN?.trim() && !!env.DATAFORSEO_PASSWORD?.trim();
}

/**
 * A per-call cost override for the budget guard (DATAFORSEO_SERP_COST_USD and
 * friends). A blank, malformed or negative value means unset: .env files list
 * these as `NAME=`, and Number("") is 0, which would record every call as free
 * and the SERP budget would never trip.
 */
export function vendorCostUsd(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** At least one vendor the client can actually call. */
export function serpConfigured(env: Env = process.env): boolean {
  return dataForSeoConfigured(env) || serpApiKey(env) !== null;
}

/** The vendors that are configured, in the order the client prefers them for bulk work. */
export function configuredSerpVendors(env: Env = process.env): SerpVendor[] {
  const out: SerpVendor[] = [];
  if (dataForSeoConfigured(env)) out.push("dataforseo");
  if (serpApiKey(env) !== null) out.push("serpapi");
  return out;
}

/**
 * AEO_SERP_AIO_PROVIDER pins the vendor that answers AI Overview questions
 * when both are configured (default: SerpApi, whose overview JSON carries the
 * cited references natively). Anything else, or a vendor that is not
 * configured, is ignored.
 */
export function aioVendorPreference(env: Env = process.env): SerpVendor | null {
  const v = env.AEO_SERP_AIO_PROVIDER?.trim().toLowerCase();
  if (v !== "serpapi" && v !== "dataforseo") return null;
  return configuredSerpVendors(env).includes(v) ? v : null;
}
