import { NextResponse } from "next/server";
import { createConnection, verifyOAuthState } from "@/lib/connectors";
import { exchangeGoogleCode, googleOAuthFromEnv } from "@/lib/connectors/google";
import { vaultSecrets } from "@/lib/secrets/vault";

export const runtime = "nodejs";

const DEFAULT_RETURN = "/settings/connectors";

function redirectTo(req: Request, path: string, params: Record<string, string>) {
  const url = new URL(path, req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
}

/**
 * Google OAuth callback. The signed `state` — not a session — says which org
 * and site this grant belongs to, so a forged or expired state is a 400 and
 * nothing is written. The refresh token goes to Vault; the row keeps a ref.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const state = verifyOAuthState(process.env.OAUTH_STATE_SECRET ?? "", searchParams.get("state"));
  if (!state || state.provider !== "google") return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  const returnTo = state.returnTo ?? DEFAULT_RETURN;

  const denied = searchParams.get("error");
  if (denied) return redirectTo(req, returnTo, { connector: "google", error: denied });
  const code = searchParams.get("code");
  if (!code) return redirectTo(req, returnTo, { connector: "google", error: "missing_code" });

  try {
    const grant = await exchangeGoogleCode(googleOAuthFromEnv(process.env), code);
    const conn = await createConnection(
      {
        orgId: state.orgId,
        siteId: state.siteId,
        provider: "google",
        secret: grant.refreshToken,
        externalAccountId: grant.email,
        externalAccountName: grant.email,
        config: {},
        scope: [],
        // Pending until the customer picks the GSC property / GA4 stream; sync is a no-op without scope.
        status: "pending",
        createdBy: state.userId ?? null,
      },
      vaultSecrets(),
    );
    return redirectTo(req, returnTo, { connected: "google", id: conn.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "exchange_failed";
    return redirectTo(req, returnTo, { connector: "google", error: message.slice(0, 200) });
  }
}
