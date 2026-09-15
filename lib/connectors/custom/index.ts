import { z } from "zod";
import { htmlToMarkdown } from "@/lib/audit/html";
import { safeFetch, type FetchOptions } from "@/lib/fetch";
import { upsertDocuments, type DocumentInput } from "../store";
import { ConnectorError, type Connector, type ConnectionRow, type ConnectorContext, type SyncResult } from "../types";

/**
 * Custom connector: a source the customer defines instead of one we ship.
 *
 *  - `api`  an HTTP endpoint returning JSON (a list of records, mapped to
 *           documents through a small field map) or plain text / HTML /
 *           Markdown (one document).
 *  - `mcp`  a Model Context Protocol server over Streamable HTTP; every
 *           resource it lists (optionally filtered by URI prefix) is read
 *           and becomes a document.
 *
 * Either way the output is context.context_documents, the same table Slack
 * and the website crawl fill, so redaction, chunking, facts and retrieval
 * see the source with no extra plumbing. The token, when there is one, is in
 * Vault; config holds the URL, the kind and the mapping only. Every request
 * goes through safeFetch, so a URL pointing at a private network is refused.
 */

export const customAuthSchema = z.object({
  type: z.enum(["none", "bearer", "header"]).default("none"),
  /** For `header`: the header that carries the secret (e.g. X-API-Key). */
  headerName: z.string().trim().max(100).optional(),
});

export const customConfigSchema = z.object({
  kind: z.enum(["api", "mcp"]),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url(),
  auth: customAuthSchema.default({ type: "none" }),
  /** api: dot path to the array of records in the JSON response; empty = the response itself. */
  itemsPath: z.string().trim().max(200).optional().default(""),
  /** api: dot paths inside each record; blank slots fall back to common names. */
  fields: z.object({ id: z.string().trim().max(100).optional().default(""), title: z.string().trim().max(100).optional().default(""), text: z.string().trim().max(100).optional().default(""), updatedAt: z.string().trim().max(100).optional().default("") }).optional().default({ id: "", title: "", text: "", updatedAt: "" }),
  /** mcp: only resources whose URI starts with this. */
  resourceFilter: z.string().trim().max(500).optional().default(""),
  maxItems: z.number().int().min(1).max(2000).optional().default(500),
});
export type CustomConfig = z.infer<typeof customConfigSchema>;

export const CUSTOM_DOC_MAX_CHARS = 60_000;
const ID_KEYS = ["id", "uuid", "url", "slug", "key", "path", "name"];
const TITLE_KEYS = ["title", "name", "subject", "heading", "label"];
const TEXT_KEYS = ["text", "content", "body", "markdown", "description", "summary", "html"];
const DATE_KEYS = ["updatedAt", "updated_at", "modified", "lastModified", "last_modified", "publishedAt", "published_at", "date", "createdAt", "created_at"];

// ── shared ──────────────────────────────────────────────────────────────────

export function authHeaders(auth: CustomConfig["auth"], secret: string | null): Record<string, string> {
  if (!secret || auth.type === "none") return {};
  if (auth.type === "bearer") return { authorization: `Bearer ${secret}` };
  return { [(auth.headerName || "X-API-Key").toLowerCase()]: secret };
}

/** `a.b[0].c` → value, or undefined. Tolerant: a missing segment is undefined, never a throw. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".").flatMap((s) => s.split(/[[\]]/).filter(Boolean))) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function firstString(rec: Record<string, unknown>, explicit: string, fallbacks: string[]): string | null {
  const candidates = explicit ? [explicit] : fallbacks;
  for (const k of candidates) {
    const v = getPath(rec, k);
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function asText(v: string): string {
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(v) && /<\/(p|div|h[1-6]|li|article|section|br|span)>/i.test(v);
  return (looksHtml ? htmlToMarkdown(v) : v).slice(0, CUSTOM_DOC_MAX_CHARS);
}

// ── api ─────────────────────────────────────────────────────────────────────

/** Find the array of records in a JSON response: the configured path, else the first array under a common key, else the body itself. */
export function extractItems(json: unknown, itemsPath: string): unknown[] | null {
  const at = getPath(json, itemsPath);
  if (Array.isArray(at)) return at;
  if (itemsPath) return null;
  if (json && typeof json === "object") {
    for (const k of ["items", "data", "results", "records", "documents", "entries", "rows", "posts", "articles"]) {
      const v = (json as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const inner = extractItems(v, "");
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** One JSON record → a document, or null when it has no usable text. */
export function recordToDocument(rec: unknown, fields: CustomConfig["fields"], index: number, siteId: string | null): DocumentInput | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  const text = firstString(r, fields.text, TEXT_KEYS);
  if (!text) return null;
  const id = firstString(r, fields.id, ID_KEYS) ?? `item-${index}`;
  const title = firstString(r, fields.title, TITLE_KEYS);
  const ts = firstString(r, fields.updatedAt, DATE_KEYS);
  const sourceTs = ts && !Number.isNaN(new Date(ts).getTime()) ? new Date(ts) : null;
  return { kind: "custom_api", externalId: String(id).slice(0, 500), title, text: asText(text), metadata: { index }, sourceTs, siteId };
}

export interface ApiProbe {
  status: number;
  contentType: string;
  /** Documents the response would produce. */
  documents: DocumentInput[];
  /** Why zero documents, when that is the case. */
  note: string | null;
}

export async function probeApi(cfg: CustomConfig, secret: string | null, ctx: Pick<ConnectorContext, "fetchImpl" | "env">, siteId: string | null): Promise<ApiProbe> {
  const res = await safeFetch(cfg.url, fetchOpts(ctx, { headers: { accept: "application/json, text/markdown, text/plain, text/html;q=0.8", ...authHeaders(cfg.auth, secret) } }));
  if (!res.ok) throw new ConnectorError("custom", res.status === 401 || res.status === 403 ? "auth" : "http_error", `custom: ${cfg.url} answered ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ""}`);
  const isJson = /json/i.test(res.contentType) || /^\s*[[{]/.test(res.body);
  if (isJson) {
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new ConnectorError("custom", "bad_json", `custom: ${cfg.url} did not return valid JSON`);
    }
    const items = extractItems(json, cfg.itemsPath);
    if (!items) {
      // A single object with text is one document.
      const single = recordToDocument(json, cfg.fields, 0, siteId);
      return { status: res.status, contentType: res.contentType, documents: single ? [single] : [], note: single ? null : `no array of records found${cfg.itemsPath ? ` at "${cfg.itemsPath}"` : ""}; set the items path` };
    }
    const docs = items.slice(0, cfg.maxItems).map((it, i) => recordToDocument(it, cfg.fields, i, siteId)).filter((d): d is DocumentInput => !!d);
    return { status: res.status, contentType: res.contentType, documents: docs, note: docs.length === 0 && items.length > 0 ? `found ${items.length} records but none had a text field (tried ${cfg.fields.text || TEXT_KEYS.join(", ")}); set the text field` : null };
  }
  const text = asText(res.body);
  if (!text.trim()) return { status: res.status, contentType: res.contentType, documents: [], note: "the response body is empty" };
  const doc: DocumentInput = { kind: "custom_page", externalId: cfg.url, title: cfg.name, text, metadata: { contentType: res.contentType }, sourceTs: new Date(), siteId };
  return { status: res.status, contentType: res.contentType, documents: [doc], note: null };
}

function fetchOpts(ctx: Pick<ConnectorContext, "fetchImpl" | "env">, extra: FetchOptions): FetchOptions {
  return { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, maxRetries: 1, fetchImpl: ctx.fetchImpl, allowPrivate: ctx.env.AEO_FETCH_ALLOW_PRIVATE === "1", ...extra };
}

// ── mcp ─────────────────────────────────────────────────────────────────────

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse { id?: number | string | null; result?: unknown; error?: { code?: number; message?: string } }

/** A Streamable HTTP response is JSON or an SSE stream; return the JSON-RPC response for `id` either way. */
export function parseJsonRpcResponse(body: string, contentType: string, id: number): JsonRpcResponse | null {
  if (/text\/event-stream/i.test(contentType)) {
    for (const block of body.split(/\n\n+/)) {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
        const list = Array.isArray(msg) ? msg : [msg];
        const hit = list.find((m) => m.id === id);
        if (hit) return hit;
      } catch {
        // a non-JSON event; keep looking
      }
    }
    return null;
  }
  if (!body.trim()) return null;
  const msg = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
  const list = Array.isArray(msg) ? msg : [msg];
  return list.find((m) => m.id === id) ?? list[0] ?? null;
}

export interface McpResource { uri: string; name?: string; title?: string; description?: string; mimeType?: string }
interface McpContent { uri: string; mimeType?: string; text?: string; blob?: string }

/** A minimal MCP client: initialize once, then JSON-RPC calls carrying the session id the server handed back. */
export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  public serverInfo: { name?: string; version?: string } | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly ctx: Pick<ConnectorContext, "fetchImpl" | "env">,
  ) {}

  private async rpc<T>(method: string, params?: Record<string, unknown>, notification = false): Promise<T> {
    const id = notification ? undefined : this.nextId++;
    const res = await safeFetch(
      this.url,
      fetchOpts(this.ctx, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_PROTOCOL_VERSION, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...this.headers },
      }),
    );
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (notification) return undefined as T;
    if (!res.ok) throw new ConnectorError("custom", res.status === 401 || res.status === 403 ? "auth" : "mcp_http_error", `mcp: ${method} answered ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ""}`);
    let msg: JsonRpcResponse | null;
    try {
      msg = parseJsonRpcResponse(res.body, res.contentType, id!);
    } catch {
      throw new ConnectorError("custom", "mcp_bad_response", `mcp: ${method} returned a body that is not JSON-RPC`);
    }
    if (!msg) throw new ConnectorError("custom", "mcp_bad_response", `mcp: no response to ${method}`);
    if (msg.error) throw new ConnectorError("custom", "mcp_error", `mcp: ${method} failed: ${msg.error.message ?? `code ${msg.error.code}`}`);
    return msg.result as T;
  }

  async initialize(): Promise<void> {
    const r = await this.rpc<{ serverInfo?: { name?: string; version?: string } }>("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "aeo-platform", version: "1.0" } });
    this.serverInfo = r?.serverInfo ?? null;
    await this.rpc("notifications/initialized", undefined, true);
  }

  async listResources(max: number): Promise<McpResource[]> {
    const out: McpResource[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc<{ resources?: McpResource[]; nextCursor?: string }>("resources/list", cursor ? { cursor } : {});
      out.push(...(page?.resources ?? []));
      cursor = page?.nextCursor;
    } while (cursor && out.length < max);
    return out.slice(0, max);
  }

  async readResource(uri: string): Promise<McpContent[]> {
    const r = await this.rpc<{ contents?: McpContent[] }>("resources/read", { uri });
    return r?.contents ?? [];
  }
}

export function resourceToDocument(res: McpResource, contents: McpContent[], siteId: string | null): DocumentInput | null {
  const text = contents.filter((c) => typeof c.text === "string" && c.text.trim()).map((c) => c.text!).join("\n\n");
  if (!text.trim()) return null;
  return { kind: "mcp_resource", externalId: res.uri.slice(0, 500), title: res.title ?? res.name ?? res.uri, text: asText(text), metadata: { mimeType: res.mimeType ?? contents[0]?.mimeType ?? null, description: res.description ?? null }, sourceTs: new Date(), siteId };
}

export interface McpProbe {
  server: { name?: string; version?: string } | null;
  resources: number;
  matched: number;
  sample: string[];
}

export async function probeMcp(cfg: CustomConfig, secret: string | null, ctx: Pick<ConnectorContext, "fetchImpl" | "env">): Promise<McpProbe> {
  const client = new McpClient(cfg.url, authHeaders(cfg.auth, secret), ctx);
  await client.initialize();
  const all = await client.listResources(cfg.maxItems);
  const matched = all.filter((r) => !cfg.resourceFilter || r.uri.startsWith(cfg.resourceFilter));
  return { server: client.serverInfo, resources: all.length, matched: matched.length, sample: matched.slice(0, 5).map((r) => r.uri) };
}

// ── the connector ───────────────────────────────────────────────────────────

async function secretFor(conn: Pick<ConnectionRow, "secret_ref">, ctx: Pick<ConnectorContext, "secrets">): Promise<string | null> {
  return conn.secret_ref ? ctx.secrets.get(conn.secret_ref) : null;
}

export const customConnector: Connector<CustomConfig> = {
  provider: "custom",

  async validate(conn, ctx) {
    const cfg = customConfigSchema.parse(conn.config);
    const secret = await secretFor(conn, ctx);
    if (cfg.auth.type !== "none" && !secret) throw new ConnectorError("custom", "no_token", "custom: the connection needs a token but none is in Vault");
    if (cfg.kind === "mcp") await probeMcp(cfg, secret, ctx);
    else await probeApi(cfg, secret, ctx, conn.site_id);
  },

  async sync(input, ctx): Promise<SyncResult> {
    if (input.kind === "webhook" || input.kind === "upload") return { documentsIngested: 0, metricsIngested: 0, cursor: input.cursor, detail: { skipped: `kind ${input.kind}` } };
    const conn = input.connection;
    const cfg = customConfigSchema.parse(conn.config);
    const secret = await secretFor(conn, ctx);
    const now = ctx.now();
    if (cfg.kind === "api") {
      const probe = await probeApi(cfg, secret, ctx, conn.site_id);
      const written = await upsertDocuments(conn, probe.documents, { retentionDays: null }, ctx.sql);
      return { documentsIngested: written, metricsIngested: 0, cursor: { syncedAt: now.toISOString() }, detail: { kind: "api", status: probe.status, contentType: probe.contentType, documents: probe.documents.length, written, note: probe.note } };
    }
    const client = new McpClient(cfg.url, authHeaders(cfg.auth, secret), ctx);
    await client.initialize();
    const resources = (await client.listResources(cfg.maxItems)).filter((r) => !cfg.resourceFilter || r.uri.startsWith(cfg.resourceFilter));
    const docs: DocumentInput[] = [];
    const failed: string[] = [];
    for (const r of resources) {
      try {
        const doc = resourceToDocument(r, await client.readResource(r.uri), conn.site_id);
        if (doc) docs.push(doc);
      } catch (e) {
        failed.push(`${r.uri}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const written = await upsertDocuments(conn, docs, { retentionDays: null }, ctx.sql);
    return { documentsIngested: written, metricsIngested: 0, cursor: { syncedAt: now.toISOString() }, detail: { kind: "mcp", server: client.serverInfo, resources: resources.length, documents: docs.length, written, failed: failed.slice(0, 20) } };
  },
};
