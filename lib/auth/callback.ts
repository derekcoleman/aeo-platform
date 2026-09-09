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

/**
 * The app must live on exactly one hostname: Supabase's PKCE verifier and
 * the session are cookies, and cookies do not cross hosts. Vercel gives a
 * project several aliases (`<project>-<team>.vercel.app`,
 * `<project>-<hash>.vercel.app`, ...); a link requested on one and finished
 * on another fails with "code verifier not found". When APP_URL is set and
 * this is the production deployment, every other host redirects to it,
 * path and query intact. Previews and local dev are left alone.
 */
export function canonicalHostRedirect(url: URL, env: Record<string, string | undefined> = process.env): URL | null {
  const app = env.APP_URL?.trim();
  if (!app || env.VERCEL_ENV !== "production") return null;
  let canonical: URL;
  try {
    canonical = new URL(app);
  } catch {
    return null;
  }
  if (canonical.host === url.host) return null;
  const target = new URL(url.pathname + url.search, canonical.origin);
  return target;
}
