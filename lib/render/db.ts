import postgres from "postgres";

/**
 * The render path's database connection.
 *
 * RENDERER_DATABASE_URL points at the `renderer` role from migration 0001:
 * SELECT on content.published_pages and content.site_render_config, and
 * nothing else. Not the service role, and not a user JWT — there is no user on
 * this path, so there is nothing for RLS to key on.
 *
 * This is the last layer of the isolation story. Combined with the tenant id
 * living in the internal route path and the customer's Worker verifying
 * X-AEO-Site, the worst a bug here can do is serve published content for the
 * wrong site — which their edge then catches and fails open on.
 */
let sql: postgres.Sql | null = null;

export function rendererDb(): postgres.Sql {
  if (sql) return sql;
  const url = process.env.RENDERER_DATABASE_URL;
  if (!url) throw new Error("RENDERER_DATABASE_URL is not set");
  sql = postgres(url, { max: 4, idle_timeout: 20, prepare: false });
  return sql;
}
