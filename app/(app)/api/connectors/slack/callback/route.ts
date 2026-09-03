import { NextResponse } from "next/server";
import { createConnection, verifyOAuthState } from "@/lib/connectors";
import { exchangeSlackCode, slackOAuthFromEnv } from "@/lib/connectors/slack";
import { vaultSecrets } from "@/lib/secrets/vault";

export const runtime = "nodejs";

const DEFAULT_RETURN = "/settings/connectors";

function redirectTo(req: Request, path: string, params: Record<string, string>) {
  const url = new URL(path, req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
}

/**
 * Slack OAuth v2 callback. Bot token → Vault. The connection starts with no
 * channels: `scope` is empty until the customer picks them, so a fresh
 * install reads nothing.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const state = verifyOAuthState(process.env.OAUTH_STATE_SECRET ?? "", searchParams.get("state"));
  if (!state || state.provider !== "slack") return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  const returnTo = state.returnTo ?? DEFAULT_RETURN;

  const denied = searchParams.get("error");
  if (denied) return redirectTo(req, returnTo, { connector: "slack", error: denied });
  const code = searchParams.get("code");
  if (!code) return redirectTo(req, returnTo, { connector: "slack", error: "missing_code" });

  try {
    const grant = await exchangeSlackCode(slackOAuthFromEnv(process.env), code);
    const conn = await createConnection(
      {
        orgId: state.orgId,
        siteId: state.siteId,
        provider: "slack",
        secret: grant.botToken,
        externalAccountId: grant.teamId,
        externalAccountName: grant.teamName,
        config: { teamId: grant.teamId, channels: [] },
        scope: [],
        status: "active",
        createdBy: state.userId ?? null,
      },
      vaultSecrets(),
    );
    return redirectTo(req, returnTo, { connected: "slack", id: conn.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "exchange_failed";
    return redirectTo(req, returnTo, { connector: "slack", error: message.slice(0, 200) });
  }
}
