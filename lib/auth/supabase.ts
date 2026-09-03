import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/db/env";

/**
 * Supabase Auth clients for the app plane. Three shapes, one config:
 * - server components / server actions / route handlers (cookies() based),
 * - the browser (lib/auth/supabase-browser.ts — kept apart so client bundles
 *   never pull in next/headers),
 * - middleware (refreshes the session cookie on the way through).
 *
 * The public render path never uses any of these — there is no user there.
 */

function config(): { url: string; key: string } {
  const url = supabaseUrl();
  const key = supabasePublishableKey();
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set");
  return { url, key };
}

export function isAuthConfigured(): boolean {
  return !!supabaseUrl() && !!supabasePublishableKey();
}

export async function supabaseServer() {
  const { url, key } = config();
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          // Server components cannot set cookies; middleware refreshes the session.
        }
      },
    },
  });
}

/** Middleware: refresh the auth session and mirror any rotated cookie onto the response. */
export async function refreshSession(req: NextRequest, res: NextResponse): Promise<{ userId: string | null }> {
  if (!isAuthConfigured()) return { userId: null };
  const { url, key } = config();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        for (const c of list) res.cookies.set(c.name, c.value, c.options);
      },
    },
  });
  const { data } = await client.auth.getUser();
  return { userId: data.user?.id ?? null };
}
