import { createBrowserClient } from "@supabase/ssr";

export interface BrowserSupabaseConfig {
  url: string;
  key: string;
}

/**
 * Browser client. Prefer passing the config from a server component
 * (`supabaseUrl()` / `supabasePublishableKey()` in lib/db/env accept both our
 * variable names and the Vercel↔Supabase integration's). The inlined
 * NEXT_PUBLIC_* fallback only works when those exact names were present at
 * build time, which is what left the sign-in form frozen on a deployment
 * configured through the integration.
 */
export function supabaseBrowser(config?: BrowserSupabaseConfig | null) {
  const url = config?.url || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = config?.key || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Sign-in is not configured: the Supabase URL and publishable key are missing.");
  return createBrowserClient(url, key);
}
