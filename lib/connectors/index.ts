import { appDb } from "@/lib/db/app";
import { vaultSecrets } from "@/lib/secrets/vault";
import { googleConnector } from "./google";
import { profoundConnector } from "./profound";
import { slackConnector } from "./slack";
import { webflowConnector } from "./webflow";
import type { Connector, ConnectorContext, ConnectorProvider } from "./types";

export * from "./types";
export * from "./store";
export * from "./oauth-state";
export * from "./oauth-start";
export { slackConnector } from "./slack";
export { googleConnector } from "./google";
export { profoundConnector } from "./profound";
export { webflowConnector } from "./webflow";

/** Provider → adapter. Gong/Zoom/Fireflies land here as the same shape. */
export const connectors: Record<ConnectorProvider, Connector<never>> = {
  slack: slackConnector as Connector<never>,
  google: googleConnector as Connector<never>,
  profound: profoundConnector as Connector<never>,
  webflow: webflowConnector as Connector<never>,
};

export function getConnector(provider: ConnectorProvider): Connector<never> {
  const c = connectors[provider];
  if (!c) throw new Error(`unknown connector provider ${provider}`);
  return c;
}

/** Production context: service DB, Vault, global fetch, real clock, process env. */
export function connectorContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  const sql = overrides.sql ?? appDb();
  return {
    sql,
    secrets: overrides.secrets ?? vaultSecrets(sql),
    fetchImpl: overrides.fetchImpl ?? fetch,
    now: overrides.now ?? (() => new Date()),
    env: overrides.env ?? process.env,
  };
}
