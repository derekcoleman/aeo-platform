import postgres from "postgres";

/**
 * Server-side database connection for jobs and API routes.
 *
 * DATABASE_URL is the service connection: it bypasses RLS, so every query
 * through it must scope by org_id/site_id explicitly. User-facing reads
 * should go through Supabase with the user's JWT instead. This is for the
 * paths that have no user — Inngest jobs, webhooks, the public audit.
 */
let sql: postgres.Sql | null = null;

export function appDb(): postgres.Sql {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  sql = postgres(url, { max: 8, idle_timeout: 20, prepare: false });
  return sql;
}

/** Test seam: swap the connection (e.g. for a fixture database). */
export function setAppDb(next: postgres.Sql | null): void {
  sql = next;
}
