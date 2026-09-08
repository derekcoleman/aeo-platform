/**
 * Where a user goes after the magic link / OAuth round trip, and how a
 * sign-in code that lands on the wrong page is recovered.
 *
 * Supabase only redirects to an address on its allow list, compared with
 * the query string included, so the callback URL we hand it carries no
 * query at all. The post-login destination travels in a short-lived cookie
 * instead. When the allow list still does not match (or the Site URL is
 * used as the fallback), the code arrives on the home page; the middleware
 * spots it and forwards it to the callback so the session still gets made.
 */

export const NEXT_COOKIE = "aeo-next";
export const NEXT_COOKIE_MAX_AGE = 600;
export const CALLBACK_PATH = "/auth/callback";

/** Only same-origin absolute paths; anything else falls back to the app root. */
export function safeNext(value: string | null | undefined, fallback = "/app"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

/** Supabase's auth parameters, present on a URL it redirected to. */
export function hasAuthParams(url: URL): boolean {
  const q = url.searchParams;
  return q.has("code") || (q.has("token_hash") && q.has("type"));
}

/**
 * If `url` carries Supabase auth parameters but is not the callback route,
 * return the callback URL to redirect to (auth params preserved, the original
 * path kept as the destination unless one was already given). Otherwise null.
 */
export function strayAuthRedirect(url: URL): URL | null {
  if (url.pathname === CALLBACK_PATH || !hasAuthParams(url)) return null;
  const target = new URL(CALLBACK_PATH, url.origin);
  for (const key of ["code", "token_hash", "type"]) {
    const v = url.searchParams.get(key);
    if (v) target.searchParams.set(key, v);
  }
  const explicit = url.searchParams.get("next");
  const dest = explicit ? safeNext(explicit) : url.pathname !== "/" ? url.pathname : null;
  if (dest) target.searchParams.set("next", dest);
  return target;
}
