/**
 * Where the database and Supabase settings come from.
 *
 * Two naming schemes are accepted. Ours (`.env.example`) and the one the
 * Vercel ↔ Supabase Marketplace integration injects when a Supabase project
 * is connected to a Vercel project (`POSTGRES_URL`, `SUPABASE_URL`,
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, …). Accepting
 * both means "connect Supabase to Vercel" is the integration's one click plus
 * a single manual secret — the renderer role's password — instead of five
 * hand-copied variables.
 *
 * Pure functions over an env object so the resolution is unit-tested and the
 * connection modules stay one line each.
 */

type Env = Record<string, string | undefined>;

const first = (env: Env, ...names: string[]): string | null => {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return null;
};

/** Service connection for jobs and API routes. Ours first, then the integration's pooled URL. */
export function appDatabaseUrl(env: Env = process.env): string | null {
  return first(env, "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL");
}

export function supabaseUrl(env: Env = process.env): string | null {
  return first(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
}

export function supabasePublishableKey(env: Env = process.env): string | null {
  return first(env, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY");
}

export function supabaseServiceRoleKey(env: Env = process.env): string | null {
  return first(env, "SUPABASE_SERVICE_ROLE_KEY");
}

/**
 * Rewrite a Supabase connection string to authenticate as the `renderer`
 * role. Supavisor pooler usernames carry the project ref as a suffix
 * (`postgres.<ref>`), which the renderer must keep (`renderer.<ref>`); a
 * direct connection has a bare username. Everything else (host, port,
 * database, query) is preserved. Returns null when the URL does not parse.
 */
export function rendererUrlFrom(baseUrl: string, password: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
  const suffix = decodeURIComponent(u.username).split(".").slice(1).join(".");
  u.username = suffix ? `renderer.${suffix}` : "renderer";
  u.password = encodeURIComponent(password);
  return u.toString();
}

/**
 * The renderer's connection. Explicit `RENDERER_DATABASE_URL` wins; otherwise
 * it is derived from the app connection with `RENDERER_DB_PASSWORD`, so the
 * integration-provided URL plus one secret is enough. Never falls back to the
 * service connection: the renderer reading as `postgres` would be the exact
 * privilege escalation migration 0001 exists to rule out.
 */
export function rendererDatabaseUrl(env: Env = process.env): string | null {
  const explicit = first(env, "RENDERER_DATABASE_URL");
  if (explicit) return explicit;
  const password = first(env, "RENDERER_DB_PASSWORD");
  const base = appDatabaseUrl(env);
  return password && base ? rendererUrlFrom(base, password) : null;
}
