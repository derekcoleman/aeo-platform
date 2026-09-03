import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client. Next only inlines NEXT_PUBLIC_* when referenced literally,
 * so this cannot go through lib/db/env's dynamic lookup.
 */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured for the browser (NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY)");
  return createBrowserClient(url, key);
}
