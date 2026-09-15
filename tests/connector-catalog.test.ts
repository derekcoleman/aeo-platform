import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, connectionsFor, connectorDef, connectorState, GROUP_LABELS } from "@/lib/connectors/catalog";
import type { ConnectionRow } from "@/lib/connectors/types";

const row = (over: Partial<ConnectionRow>): ConnectionRow => ({ id: "c", org_id: "o", site_id: "s1", provider: "google", status: "active", enabled: true, config: {}, scope: [], secret_ref: null, external_account_id: null, external_account_name: null, last_synced_at: null, last_error: null, ...over });

describe("connector catalogue", () => {
  it("lists every provider the registry knows, once per product, in a known group", () => {
    const providers = new Set(CONNECTOR_CATALOG.map((d) => d.provider));
    expect([...providers].sort()).toEqual(["custom", "google", "profound", "slack", "webflow", "website"]);
    expect(CONNECTOR_CATALOG.filter((d) => d.provider === "google").map((d) => d.key)).toEqual(["gsc", "ga4"]);
    const keys = CONNECTOR_CATALOG.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of CONNECTOR_CATALOG) {
      expect(GROUP_LABELS[d.group]).toBeDefined();
      expect(d.feeds.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(40);
    }
    expect(connectorDef("custom").scope).toBe("org");
  });

  it("matches rows to entries by provider and scope, skipping disconnected ones", () => {
    const rows = [row({ id: "g1", provider: "google", site_id: "s1" }), row({ id: "g2", provider: "google", site_id: "s2", status: "disconnected" }), row({ id: "sl", provider: "slack", site_id: null }), row({ id: "cu", provider: "custom", site_id: "s2" })];
    expect(connectionsFor(connectorDef("gsc"), rows).map((r) => r.id)).toEqual(["g1"]);
    expect(connectionsFor(connectorDef("ga4"), rows, "s1").map((r) => r.id)).toEqual(["g1"]);
    expect(connectionsFor(connectorDef("ga4"), rows, "s2")).toEqual([]);
    expect(connectionsFor(connectorDef("slack"), rows, "s1").map((r) => r.id)).toEqual(["sl"]);
    expect(connectionsFor(connectorDef("custom"), rows, "s1").map((r) => r.id)).toEqual(["cu"]);
  });

  it("says needs setup for a grant with nothing selected, and connected once it is", () => {
    const grant = row({ status: "pending" });
    expect(connectorState(connectorDef("gsc"), grant)).toBe("needs_setup");
    expect(connectorState(connectorDef("ga4"), grant)).toBe("needs_setup");
    const half = row({ config: { gscProperty: "sc-domain:acme.com" } });
    expect(connectorState(connectorDef("gsc"), half)).toBe("connected");
    expect(connectorState(connectorDef("ga4"), half)).toBe("needs_setup");
    expect(connectorState(connectorDef("gsc"), row({ status: "error", config: { gscProperty: "x" } }))).toBe("error");
    expect(connectorState(connectorDef("gsc"), null)).toBe("not_connected");
    expect(connectorState(connectorDef("gsc"), row({ status: "disconnected" }))).toBe("not_connected");
  });

  it("treats a Slack install with no channels and no destinations as needing setup", () => {
    const fresh = row({ provider: "slack", site_id: null, config: { teamId: "T", channels: [] } });
    expect(connectorState(connectorDef("slack"), fresh)).toBe("needs_setup");
    expect(connectorState(connectorDef("slack"), { ...fresh, scope: ["C1"] })).toBe("connected");
    expect(connectorState(connectorDef("slack"), { ...fresh, config: { ...fresh.config, approvalsChannel: "C9" } })).toBe("connected");
    expect(connectorState(connectorDef("webflow"), row({ provider: "webflow", enabled: false }))).toBe("needs_setup");
    expect(connectorState(connectorDef("custom"), row({ provider: "custom" }))).toBe("connected");
  });
});
