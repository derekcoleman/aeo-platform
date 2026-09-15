import { describe, expect, it } from "vitest";
import { authHeaders, customConfigSchema, customConnector, extractItems, getPath, McpClient, parseJsonRpcResponse, probeApi, probeMcp, recordToDocument, resourceToDocument } from "@/lib/connectors/custom";
import { ConnectorError } from "@/lib/connectors/types";
import { memorySecrets } from "@/lib/secrets/vault";
import { fakeSql } from "./helpers/fake-sql";

const env = { NODE_ENV: "test", AEO_FETCH_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv;
const json = (o: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("field mapping", () => {
  it("getPath walks dots and brackets and never throws", () => {
    const o = { a: { b: [{ c: 1 }, { c: 2 }] }, s: "x" };
    expect(getPath(o, "a.b[1].c")).toBe(2);
    expect(getPath(o, "a.b.0.c")).toBe(1);
    expect(getPath(o, "a.nope.c")).toBeUndefined();
    expect(getPath(o, "s.length")).toBeUndefined();
    expect(getPath(o, "")).toBe(o);
  });

  it("finds the record array at the configured path, under a common key, or not at all", () => {
    expect(extractItems({ data: { items: [1, 2] } }, "data.items")).toEqual([1, 2]);
    expect(extractItems({ data: { items: [1, 2] } }, "")).toEqual([1, 2]);
    expect(extractItems([{ id: 1 }], "")).toEqual([{ id: 1 }]);
    expect(extractItems({ results: [] }, "")).toEqual([]);
    expect(extractItems({ foo: "bar" }, "")).toBeNull();
    expect(extractItems({ data: { items: [1] } }, "wrong.path")).toBeNull();
  });

  it("maps a record with explicit fields or common names, converting HTML bodies to markdown", () => {
    const fields = { id: "", title: "", text: "", updatedAt: "" };
    const d = recordToDocument({ id: 7, title: "Pricing", body: "<h2>Plans</h2><p>Three tiers.</p>", updated_at: "2026-01-02T00:00:00Z" }, fields, 0, "s1")!;
    expect(d).toMatchObject({ kind: "custom_api", externalId: "7", title: "Pricing", siteId: "s1" });
    expect(d.text).toContain("## Plans");
    expect(d.sourceTs).toEqual(new Date("2026-01-02T00:00:00Z"));
    const explicit = recordToDocument({ attributes: { slug: "a", headline: "H", content: "text here" } }, { id: "attributes.slug", title: "attributes.headline", text: "attributes.content", updatedAt: "" }, 3, null)!;
    expect(explicit).toMatchObject({ externalId: "a", title: "H", text: "text here" });
    expect(recordToDocument({ id: 1 }, fields, 0, null)).toBeNull();
    expect(recordToDocument({ description: "only text" }, fields, 4, null)!.externalId).toBe("item-4");
  });

  it("builds auth headers for bearer and custom-header modes only when a secret exists", () => {
    expect(authHeaders({ type: "none" }, "x")).toEqual({});
    expect(authHeaders({ type: "bearer" }, "tok")).toEqual({ authorization: "Bearer tok" });
    expect(authHeaders({ type: "header", headerName: "X-Api-Key" }, "k")).toEqual({ "x-api-key": "k" });
    expect(authHeaders({ type: "header" }, "k")).toEqual({ "x-api-key": "k" });
    expect(authHeaders({ type: "bearer" }, null)).toEqual({});
  });
});

describe("probeApi", () => {
  const cfg = customConfigSchema.parse({ kind: "api", name: "Docs", url: "https://api.example.com/articles", auth: { type: "bearer" } });

  it("returns one document per JSON record and sends the token", async () => {
    let auth = "";
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string>).authorization);
      return json({ data: { items: [{ id: "a", title: "A", body: "alpha text" }, { id: "b", title: "B", body: "" }] } });
    }) as typeof fetch;
    const p = await probeApi(cfg, "tok", { fetchImpl, env }, "s1");
    expect(auth).toBe("Bearer tok");
    expect(p.documents.map((d) => d.externalId)).toEqual(["a"]);
    expect(p.note).toBeNull();
  });

  it("turns a text or markdown response into a single document", async () => {
    const fetchImpl = (async () => new Response("# Guide\n\nSome words.", { status: 200, headers: { "content-type": "text/markdown" } })) as typeof fetch;
    const p = await probeApi({ ...cfg, auth: { type: "none" } }, null, { fetchImpl, env }, null);
    expect(p.documents).toHaveLength(1);
    expect(p.documents[0]).toMatchObject({ kind: "custom_page", externalId: cfg.url, title: "Docs" });
  });

  it("explains an empty result and classifies auth failures", async () => {
    const empty = (async () => json({ data: { items: [{ id: 1 }] } })) as typeof fetch;
    expect((await probeApi(cfg, "t", { fetchImpl: empty, env }, null)).note).toMatch(/none had a text field/);
    const noArray = (async () => json({ hello: "world" })) as typeof fetch;
    expect((await probeApi(cfg, "t", { fetchImpl: noArray, env }, null)).note).toMatch(/no array of records/);
    const denied = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    await expect(probeApi(cfg, "t", { fetchImpl: denied, env }, null)).rejects.toMatchObject({ code: "auth" });
    const broken = (async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(probeApi(cfg, "t", { fetchImpl: broken, env }, null)).rejects.toMatchObject({ code: "bad_json" });
  });

  it("refuses private-network URLs", async () => {
    const never = (async () => json({})) as typeof fetch;
    await expect(probeApi({ ...cfg, url: "http://169.254.169.254/latest" }, null, { fetchImpl: never, env: { NODE_ENV: "test" } as NodeJS.ProcessEnv }, null)).rejects.toThrow();
  });
});

describe("parseJsonRpcResponse", () => {
  it("reads a plain JSON body and an SSE stream, matching on id", () => {
    expect(parseJsonRpcResponse('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}', "application/json", 3)).toMatchObject({ id: 3, result: { ok: true } });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"first":true}}\n\n: keepalive\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"second":true}}\n\n';
    expect(parseJsonRpcResponse(sse, "text/event-stream", 2)).toMatchObject({ id: 2, result: { second: true } });
    expect(parseJsonRpcResponse(sse, "text/event-stream", 9)).toBeNull();
    expect(parseJsonRpcResponse("", "application/json", 1)).toBeNull();
  });
});

function fakeMcp(opts: { sse?: boolean; failRead?: string } = {}) {
  const calls: { method: string; session: string | null; params?: Record<string, unknown> }[] = [];
  const resources = [
    { uri: "docs://pricing", name: "Pricing", mimeType: "text/markdown" },
    { uri: "docs://security", name: "Security" },
    { uri: "img://logo", name: "Logo", mimeType: "image/png" },
  ];
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    const headers = init?.headers as Record<string, string>;
    calls.push({ method: req.method, session: headers["mcp-session-id"] ?? null, params: req.params });
    if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    if (req.method === "initialize") result = { protocolVersion: "2025-06-18", serverInfo: { name: "docs-mcp", version: "1.0" }, capabilities: { resources: {} } };
    else if (req.method === "resources/list") result = req.params?.cursor ? { resources: resources.slice(2) } : { resources: resources.slice(0, 2), nextCursor: "p2" };
    else if (req.method === "resources/read") {
      const uri = String(req.params?.uri);
      if (uri === opts.failRead) return json({ jsonrpc: "2.0", id: req.id, error: { code: -32002, message: "not found" } });
      result = { contents: uri.startsWith("img://") ? [{ uri, mimeType: "image/png", blob: "AAAA" }] : [{ uri, mimeType: "text/markdown", text: `# ${uri}\n\nbody` }] };
    } else result = {};
    const msg = { jsonrpc: "2.0", id: req.id, result };
    const h: Record<string, string> = { "mcp-session-id": "sess-1" };
    if (opts.sse) return new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { status: 200, headers: { ...h, "content-type": "text/event-stream" } });
    return json(msg, { headers: { ...h, "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("MCP", () => {
  const cfg = customConfigSchema.parse({ kind: "mcp", name: "Docs MCP", url: "https://mcp.example.com/mcp", auth: { type: "header", headerName: "X-Key" } });

  it("initializes, carries the session id, pages resources and reads text contents (JSON and SSE)", async () => {
    for (const sse of [false, true]) {
      const mcp = fakeMcp({ sse });
      const client = new McpClient(cfg.url, authHeaders(cfg.auth, "k"), { fetchImpl: mcp.fetchImpl, env });
      await client.initialize();
      expect(client.serverInfo).toEqual({ name: "docs-mcp", version: "1.0" });
      const list = await client.listResources(10);
      expect(list.map((r) => r.uri)).toEqual(["docs://pricing", "docs://security", "img://logo"]);
      expect(mcp.calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "resources/list", "resources/list"]);
      expect(mcp.calls[0]!.session).toBeNull();
      expect(mcp.calls.slice(1).every((c) => c.session === "sess-1")).toBe(true);
      const doc = resourceToDocument(list[0]!, await client.readResource(list[0]!.uri), "s1")!;
      expect(doc).toMatchObject({ kind: "mcp_resource", externalId: "docs://pricing", title: "Pricing", siteId: "s1" });
      expect(doc.text).toContain("docs://pricing");
      expect(resourceToDocument(list[2]!, await client.readResource(list[2]!.uri), null)).toBeNull();
    }
  });

  it("probeMcp applies the URI filter and reports the server", async () => {
    const mcp = fakeMcp();
    const p = await probeMcp({ ...cfg, resourceFilter: "docs://" }, "k", { fetchImpl: mcp.fetchImpl, env });
    expect(p).toEqual({ server: { name: "docs-mcp", version: "1.0" }, resources: 3, matched: 2, sample: ["docs://pricing", "docs://security"] });
  });

  it("surfaces JSON-RPC errors as connector errors", async () => {
    const mcp = fakeMcp({ failRead: "docs://pricing" });
    const client = new McpClient(cfg.url, {}, { fetchImpl: mcp.fetchImpl, env });
    await client.initialize();
    await expect(client.readResource("docs://pricing")).rejects.toMatchObject({ code: "mcp_error" });
  });
});

describe("customConnector", () => {
  const base = { id: "c1", org_id: "o1", site_id: "s1", provider: "custom" as const, status: "active" as const, enabled: true, scope: [], secret_ref: "vault:c1", external_account_id: null, external_account_name: null, last_synced_at: null, last_error: null };

  it("syncs an MCP server into documents, skipping unreadable resources", async () => {
    const mcp = fakeMcp({ failRead: "docs://security" });
    const secrets = memorySecrets();
    await secrets.put("vault:c1", "k");
    const sql = fakeSql([[/^insert into context\.context_documents/, () => [{ id: "d" }]]]);
    const conn = { ...base, config: customConfigSchema.parse({ kind: "mcp", name: "Docs", url: "https://mcp.example.com/mcp", auth: { type: "bearer" } }) };
    const r = await customConnector.sync({ connection: conn, kind: "backfill", cursor: null }, { sql, secrets, fetchImpl: mcp.fetchImpl, now: () => new Date("2026-09-15T00:00:00Z"), env });
    expect(r.documentsIngested).toBe(1);
    expect(r.detail).toMatchObject({ kind: "mcp", resources: 3, documents: 1, written: 1 });
    expect((r.detail as { failed: string[] }).failed[0]).toMatch(/docs:\/\/security/);
    expect(sql.queries.filter((q) => q.text.startsWith("insert into context.context_documents"))).toHaveLength(1);
  });

  it("syncs an API endpoint and validates before connecting", async () => {
    const fetchImpl = (async () => json([{ id: 1, name: "One", content: "first" }, { id: 2, name: "Two", content: "second" }])) as typeof fetch;
    const secrets = memorySecrets();
    const sql = fakeSql([[/^insert into context\.context_documents/, () => [{ id: "d" }]]]);
    const conn = { ...base, secret_ref: null, config: customConfigSchema.parse({ kind: "api", name: "List", url: "https://api.example.com/list" }) };
    const ctx = { sql, secrets, fetchImpl, now: () => new Date(), env };
    await expect(customConnector.validate!(conn, ctx)).resolves.toBeUndefined();
    const r = await customConnector.sync({ connection: conn, kind: "incremental", cursor: null }, ctx);
    expect(r.documentsIngested).toBe(2);
    expect(r.detail).toMatchObject({ kind: "api", status: 200, documents: 2 });
    const needsToken = { ...conn, config: { ...conn.config, auth: { type: "bearer" as const } } };
    await expect(customConnector.validate!(needsToken, ctx)).rejects.toBeInstanceOf(ConnectorError);
    expect(await customConnector.sync({ connection: conn, kind: "webhook", cursor: null }, ctx)).toMatchObject({ documentsIngested: 0 });
  });
});
