import { describe, expect, it, vi } from "vitest";
import {
  encodeApprovalValue,
  handleSlackEventRequest,
  handleSlackInteractionRequest,
  messageToDocument,
  parseApprovalAction,
  parseSlackEvent,
  slackConnector,
  slackSignature,
  verifySlackSignature,
  type InboundEvent,
  type SlackConfig,
} from "@/lib/connectors/slack";
import type { ConnectionRow, ConnectorContext } from "@/lib/connectors/types";
import { memorySecrets } from "@/lib/secrets/vault";
import { fakeSql } from "./helpers/fake-sql";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = new Date("2026-09-01T12:00:00Z");
const nowTs = () => String(Math.floor(NOW.getTime() / 1000));

function signed(body: string, ts = nowTs()) {
  return { body, headers: { signature: slackSignature(SECRET, ts, body), timestamp: ts } };
}

describe("verifySlackSignature", () => {
  it("accepts a fresh, correctly signed body", () => {
    const { body, headers } = signed('{"type":"url_verification","challenge":"x"}');
    expect(verifySlackSignature({ signingSecret: SECRET, body, ...headers, now: NOW })).toBe(true);
  });

  it("rejects a stale timestamp (replay)", () => {
    const ts = String(Math.floor(NOW.getTime() / 1000) - 6 * 60);
    const { body, headers } = signed("{}", ts);
    expect(verifySlackSignature({ signingSecret: SECRET, body, ...headers, now: NOW })).toBe(false);
  });

  it("rejects a tampered body and a missing signature", () => {
    const { headers } = signed("{}");
    expect(verifySlackSignature({ signingSecret: SECRET, body: "{ }", ...headers, now: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, body: "{}", timestamp: headers.timestamp, signature: null, now: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: "", body: "{}", ...headers, now: NOW })).toBe(false);
  });
});

describe("parseSlackEvent", () => {
  const envelope = (event: Record<string, unknown>) => ({ type: "event_callback", event_id: "Ev1", team_id: "T123", event });

  it("classifies url_verification, message, ignored and invalid", () => {
    expect(parseSlackEvent({ type: "url_verification", challenge: "abc" })).toEqual({ kind: "url_verification", challenge: "abc" });
    const msg = parseSlackEvent(envelope({ type: "message", channel: "C1", ts: "1.0", user: "U1", text: "hi" }));
    expect(msg.kind).toBe("message");
    if (msg.kind === "message") expect(msg.message.channel).toBe("C1");
    expect(parseSlackEvent(envelope({ type: "message", channel: "C1", ts: "1.0", subtype: "channel_join" }))).toMatchObject({ kind: "ignored", reason: "subtype channel_join" });
    expect(parseSlackEvent(envelope({ type: "message", channel: "C1", ts: "1.0", bot_id: "B1", text: "bot" }))).toMatchObject({ kind: "ignored", reason: "bot message" });
    expect(parseSlackEvent(envelope({ type: "reaction_added" }))).toMatchObject({ kind: "ignored", reason: "event type reaction_added" });
    expect(parseSlackEvent({ hello: "world" })).toMatchObject({ kind: "invalid" });
  });
});

describe("approval actions", () => {
  const approvalId = "7d9e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
  const payload = (value: string) => ({
    type: "block_actions",
    team: { id: "T123" },
    user: { id: "U9", username: "derek" },
    channel: { id: "C1" },
    message: { ts: "1700000000.000100" },
    response_url: "https://hooks.slack.com/x",
    actions: [{ action_id: "approval:approve", value, action_ts: "1700000001.000000" }],
  });

  it("round-trips encodeApprovalValue through parseApprovalAction", () => {
    const parsed = parseApprovalAction(payload(encodeApprovalValue({ approvalId, decision: "approve" })));
    expect(parsed).toMatchObject({ approvalId, decision: "approve", teamId: "T123", userId: "U9", userName: "derek", channelId: "C1", messageTs: "1700000000.000100" });
    expect(parsed?.externalId).toBe(`${approvalId}:U9:1700000001.000000`);
  });

  it("rejects malformed values and non-approval actions", () => {
    expect(parseApprovalAction(payload("not json"))).toBeNull();
    expect(parseApprovalAction(payload(JSON.stringify({ approvalId, decision: "nope" })))).toBeNull();
    expect(parseApprovalAction({ ...payload("{}"), actions: [{ action_id: "other", value: "x" }] })).toBeNull();
    expect(() => encodeApprovalValue({ approvalId: "bad", decision: "approve" })).toThrow();
  });
});

describe("messageToDocument", () => {
  const channel = { id: "C1", name: "product" };

  it("flattens a thread into one document dated by its last reply", () => {
    const doc = messageToDocument(channel, { ts: "1000.1", user: "U1", text: "We shipped SCIM " }, [
      { ts: "1000.1", user: "U1", text: "We shipped SCIM" },
      { ts: "1001.5", user: "U2", text: "Nice, docs?" },
      { ts: "1002.0", bot_id: "B1", text: "bot noise" },
    ], "site-1");
    expect(doc).toMatchObject({ kind: "slack_thread", externalId: "C1:1000.1", siteId: "site-1" });
    expect(doc?.text).toBe("[product] <U1> We shipped SCIM\n  ↳ <U2> Nice, docs?");
    expect(doc?.sourceTs).toEqual(new Date(1002000));
    expect(doc?.metadata).toMatchObject({ channelId: "C1", replyCount: 3 });
  });

  it("emits a plain message document and skips bots, blanks and ignored subtypes", () => {
    expect(messageToDocument(channel, { ts: "5.0", user: "U1", text: "hello" })).toMatchObject({ kind: "slack_message", text: "[product] <U1> hello" });
    expect(messageToDocument(channel, { ts: "5.0", bot_id: "B1", text: "hello" })).toBeNull();
    expect(messageToDocument(channel, { ts: "5.0", user: "U1", text: "   " })).toBeNull();
    expect(messageToDocument(channel, { ts: "5.0", user: "U1", subtype: "channel_join", text: "joined" })).toBeNull();
  });
});

describe("handleSlackEventRequest", () => {
  const messageBody = JSON.stringify({
    type: "event_callback",
    event_id: "Ev42",
    team_id: "T123",
    event: { type: "message", channel: "C1", ts: "1700000000.000100", user: "U1", text: "hi" },
  });

  it("answers url_verification with the challenge", async () => {
    const { body, headers } = signed(JSON.stringify({ type: "url_verification", challenge: "abc" }));
    const send = vi.fn();
    const res = await handleSlackEventRequest(body, headers, { signingSecret: SECRET, sql: fakeSql(), send, now: () => NOW });
    expect(res).toEqual({ status: 200, body: { challenge: "abc" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a bad signature before touching the ledger", async () => {
    const sql = fakeSql();
    const res = await handleSlackEventRequest(messageBody, { signature: "v0=bad", timestamp: nowTs() }, { signingSecret: SECRET, sql, send: vi.fn(), now: () => NOW });
    expect(res.status).toBe(401);
    expect(sql.queries).toHaveLength(0);
  });

  it("ledgers, resolves the connection and emits connector/webhook.received exactly once", async () => {
    let seen = 0;
    const sql = fakeSql([
      [/insert into ops\.webhook_events/, () => (seen++ === 0 ? [{ id: "w1" }] : [])],
      [/from context\.context_connections/, (q) => (q.values[0] === "T123" ? [{ id: "conn-1", org_id: "org-1" }] : [])],
    ]);
    const send = vi.fn<(event: InboundEvent) => Promise<void>>(async () => undefined);
    const { body, headers } = signed(messageBody);
    const first = await handleSlackEventRequest(body, headers, { signingSecret: SECRET, sql, send, now: () => NOW });
    expect(first).toEqual({ status: 200, body: { ok: true } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      name: "connector/webhook.received",
      data: { provider: "slack", externalId: "Ev42", connectionId: "conn-1", orgId: "org-1", payload: { channel: "C1", ts: "1700000000.000100" } },
    });
    const ledger = sql.queries.find((q) => /insert into ops\.webhook_events/.test(q.text))!;
    expect(ledger.values.slice(0, 2)).toEqual(["slack", "Ev42"]);

    const retry = await handleSlackEventRequest(body, { ...headers, retryNum: "1" }, { signingSecret: SECRET, sql, send, now: () => NOW });
    expect(retry).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("acknowledges ignored subtypes without ledgering them", async () => {
    const sql = fakeSql();
    const { body, headers } = signed(JSON.stringify({ type: "event_callback", event_id: "Ev1", team_id: "T123", event: { type: "message", channel: "C1", ts: "1.0", subtype: "channel_join" } }));
    const res = await handleSlackEventRequest(body, headers, { signingSecret: SECRET, sql, send: vi.fn(), now: () => NOW });
    expect(res).toMatchObject({ status: 200, body: { ok: true, ignored: "subtype channel_join" } });
    expect(sql.queries).toHaveLength(0);
  });
});

describe("handleSlackInteractionRequest", () => {
  const approvalId = "7d9e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

  it("emits approval/decided with the org resolved from the team", async () => {
    const sql = fakeSql([
      [/insert into ops\.webhook_events/, () => [{ id: "w1" }]],
      [/from context\.context_connections/, () => [{ id: "conn-1", org_id: "org-1" }]],
    ]);
    const payload = {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "U9", username: "derek" },
      actions: [{ action_id: "approval:changes", value: encodeApprovalValue({ approvalId, decision: "changes" }), action_ts: "1.0" }],
    };
    const { body, headers } = signed(`payload=${encodeURIComponent(JSON.stringify(payload))}`);
    const send = vi.fn<(event: InboundEvent) => Promise<void>>(async () => undefined);
    const res = await handleSlackInteractionRequest(body, headers, { signingSecret: SECRET, sql, send, now: () => NOW });
    expect(res.status).toBe(200);
    expect(send.mock.calls[0]![0]).toMatchObject({ name: "approval/decided", data: { approvalId, decision: "changes", by: { userId: "U9", name: "derek" }, source: "slack", orgId: "org-1" } });
    const ledger = sql.queries.find((q) => /insert into ops\.webhook_events/.test(q.text))!;
    expect(ledger.values[1]).toBe(`interaction:${approvalId}:U9:1.0`);
  });

  it("400s when the payload field is missing", async () => {
    const { body, headers } = signed("foo=bar");
    const res = await handleSlackInteractionRequest(body, headers, { signingSecret: SECRET, sql: fakeSql(), send: vi.fn(), now: () => NOW });
    expect(res).toEqual({ status: 400, body: { error: "missing_payload" } });
  });
});

describe("slackConnector.sync scope discipline", () => {
  function connection(scope: string[]): ConnectionRow<SlackConfig> {
    return {
      id: "conn-1",
      org_id: "org-1",
      site_id: null,
      provider: "slack",
      status: "active",
      enabled: true,
      config: { teamId: "T123", channels: [{ id: "C1", name: "product" }, { id: "C2", name: "random" }] },
      scope,
      secret_ref: "vault:connection:conn-1",
      external_account_id: "T123",
      external_account_name: "Acme",
      last_synced_at: null,
      last_error: null,
    };
  }

  function context(calls: { method: string; params: URLSearchParams; auth: string | null }[]): ConnectorContext {
    const secrets = memorySecrets();
    secrets.store.set("vault:connection:conn-1", "xoxb-test-token");
    const fetchImpl: typeof fetch = async (url, init) => {
      const method = String(url).split("/api/")[1]!;
      const params = new URLSearchParams(String(init?.body));
      const headers = init?.headers as Record<string, string>;
      calls.push({ method, params, auth: headers.authorization ?? null });
      let json: unknown = { ok: true };
      if (method === "conversations.history") {
        json = { ok: true, has_more: false, messages: params.get("channel") === "C1" ? [{ ts: "1700000100.000000", user: "U1", text: "shipped SCIM" }, { ts: "1700000050.000000", bot_id: "B1", text: "deploy bot" }] : [] };
      }
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { sql: fakeSql([[/insert into context\.context_documents/, () => [{ id: "d1" }]]]), secrets, fetchImpl, now: () => NOW, env: { NODE_ENV: "test" } };
  }

  it("reads only the channels in scope, with the vault token, and advances the cursor", async () => {
    const calls: { method: string; params: URLSearchParams; auth: string | null }[] = [];
    const ctx = context(calls);
    const result = await slackConnector.sync({ connection: connection(["C1"]), kind: "backfill", cursor: null }, ctx);
    const history = calls.filter((c) => c.method === "conversations.history");
    expect(history.map((c) => c.params.get("channel"))).toEqual(["C1"]);
    expect(history[0]!.auth).toBe("Bearer xoxb-test-token");
    expect(Number(history[0]!.params.get("oldest"))).toBe(Math.floor(NOW.getTime() / 1000) - 90 * 86_400);
    expect(result.documentsIngested).toBe(1);
    expect(result.cursor).toEqual({ C1: "1700000100.000000" });
    expect(result.detail).toEqual({ perChannel: { C1: 1 } });
    const insert = (ctx.sql as ReturnType<typeof fakeSql>).queries.find((q) => /context_documents/.test(q.text))!;
    expect(insert.values[0]).toBe("org-1");
  });

  it("syncs nothing when scope is empty (default-nothing)", async () => {
    const calls: { method: string; params: URLSearchParams; auth: string | null }[] = [];
    const result = await slackConnector.sync({ connection: connection([]), kind: "incremental", cursor: null }, context(calls));
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ documentsIngested: 0, detail: { skipped: "no channels in scope" } });
  });

  it("drops webhook messages from channels outside scope", async () => {
    const calls: { method: string; params: URLSearchParams; auth: string | null }[] = [];
    const result = await slackConnector.sync(
      { connection: connection(["C1"]), kind: "webhook", cursor: null, payload: { type: "message", channel: "C2", ts: "1.0", user: "U1", text: "secret" } },
      context(calls),
    );
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ documentsIngested: 0, detail: { skipped: "out of scope" } });
  });
});
