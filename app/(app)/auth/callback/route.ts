import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { NEXT_COOKIE, safeNext } from "@/lib/auth/callback";
import { supabaseServer } from "@/lib/auth/supabase";

/**
 * Magic link / OAuth lands here. Two shapes Supabase can send:
 * - `?code=` (PKCE): exchanged for a session using the verifier cookie the
 *   browser client stored when the link was requested;
 * - `?token_hash=&type=` (email templates built on {{ .TokenHash }}):
 *   verified directly, no verifier needed.
 * The destination comes from `?next=`, else the cookie the login form set,
 * else /app. Every failure goes back to /login with the reason.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const target = safeNext(url.searchParams.get("next") ?? req.cookies.get(NEXT_COOKIE)?.value);

  const fail = (reason: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason)}`, url.origin));
    res.cookies.delete(NEXT_COOKIE);
    return res;
  };
  if (!code && !(tokenHash && type)) return fail("missing_code");

  const supabase = await supabaseServer();
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type! });
  if (error) return fail(error.message);

  const res = NextResponse.redirect(new URL(target, url.origin));
  res.cookies.delete(NEXT_COOKIE);
  return res;
}
