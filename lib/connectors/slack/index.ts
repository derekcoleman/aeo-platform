import { upsertDocuments, type DocumentInput } from "../store";
import { ConnectorError, type Connector, type ConnectionRef, type ConnectorContext, type SyncInput, type SyncResult } from "../types";
import { slackApi, type SlackApi, type SlackChannel, type SlackMessage, type SlackResponse } from "./api";
import { IGNORED_MESSAGE_SUBTYPES, type SlackMessageEvent } from "./events";
import type { SlackOAuthConfig } from "./oauth";

export * from "./api";
export * from "./blocks";
export * from "./events";
export * from "./oauth";
export * from "./signature";

/**
 * Slack connector — inbound half. Reads history from exactly the channels in
 * `scope` (channel ids), never the workspace. Threads become one document
 * per thread; top-level messages become one document each, so a Slack
 * discussion is retrievable at the granularity it was written.
 */

export interface SlackConfig {
  teamId: string;
  /** Channels the customer selected; `scope` holds the ids, this holds the names for display. */
  channels: { id: string; name: string }[];
  /** Days of history to backfill on connect. */
  backfillDays?: number;
  /** Slack messages are retained this long; the default matches the brand-brain recency half-life × 2. */
  retentionDays?: number;
}

export type SlackCursor = Record<string, string>; // channelId -> latest ts ingested

export const SLACK_DEFAULT_BACKFILL_DAYS = 90;
export const SLACK_DEFAULT_RETENTION_DAYS = 365;
const HISTORY_PAGE = 200;
const MAX_MESSAGES_PER_CHANNEL_PER_RUN = 5000;

interface HistoryResponse extends SlackResponse { messages?: SlackMessage[]; has_more?: boolean }
interface ConversationsListResponse extends SlackResponse { channels?: SlackChannel[] }
interface ConversationInfoResponse extends SlackResponse { channel?: SlackChannel }

export function externalIdFor(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

export function slackTsToDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1000));
}

function includeMessage(m: Pick<SlackMessage, "subtype" | "bot_id" | "text">): boolean {
  if (m.bot_id) return false;
  if (m.subtype && IGNORED_MESSAGE_SUBTYPES.has(m.subtype)) return false;
  return !!m.text?.trim();
}

/** Flatten a message (plus its replies when it is a thread parent) into a document. */
export function messageToDocument(channel: { id: string; name: string }, m: SlackMessage, replies: SlackMessage[] = [], siteId: string | null = null): DocumentInput | null {
  if (!includeMessage(m)) return null;
  const isThread = replies.length > 0;
  const lines = [`[${channel.name}] <${m.user ?? "unknown"}> ${m.text!.trim()}`];
  for (const r of replies) {
    if (!includeMessage(r) || r.ts === m.ts) continue;
    lines.push(`  ↳ <${r.user ?? "unknown"}> ${r.text!.trim()}`);
  }
  return {
    kind: isThread ? "slack_thread" : "slack_message",
    externalId: externalIdFor(channel.id, m.ts),
    title: null,
    text: lines.join("\n"),
    metadata: { channelId: channel.id, channelName: channel.name, user: m.user ?? null, replyCount: replies.length, threadTs: m.thread_ts ?? null },
    sourceTs: slackTsToDate(isThread && replies.at(-1)?.ts ? replies.at(-1)!.ts : m.ts),
    siteId,
  };
}

async function fetchChannelHistory(api: SlackApi, channelId: string, oldest: string | undefined): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor: string | undefined;
  while (out.length < MAX_MESSAGES_PER_CHANNEL_PER_RUN) {
    const page = await api.call<HistoryResponse>("conversations.history", { channel: channelId, limit: HISTORY_PAGE, oldest, cursor, inclusive: false });
    out.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
    if (!page.has_more || !cursor) break;
  }
  return out;
}

async function fetchReplies(api: SlackApi, channelId: string, threadTs: string): Promise<SlackMessage[]> {
  return api.paginate<HistoryResponse, SlackMessage>("conversations.replies", { channel: channelId, ts: threadTs, limit: HISTORY_PAGE }, (p) => p.messages ?? [], 10);
}

async function tokenFor(conn: ConnectionRef, ctx: ConnectorContext): Promise<string> {
  if (!conn.secret_ref) throw new ConnectorError("slack", "no_token", "slack connection has no secret_ref");
  const token = await ctx.secrets.get(conn.secret_ref);
  if (!token) throw new ConnectorError("slack", "no_token", "slack token missing from vault");
  return token;
}

export function slackClientFor(conn: ConnectionRef, token: string, ctx: ConnectorContext): SlackApi {
  return slackApi({ token, fetchImpl: ctx.fetchImpl });
}

/** Channels the bot can see; used by the picker UI and by validate(). */
export async function listSlackChannels(api: SlackApi): Promise<SlackChannel[]> {
  return api.paginate<ConversationsListResponse, SlackChannel>(
    "conversations.list",
    { types: "public_channel,private_channel", exclude_archived: true, limit: 200 },
    (p) => p.channels ?? [],
  );
}

export const slackConnector: Connector<SlackConfig> = {
  provider: "slack",

  async validate(conn, ctx) {
    if (conn.scope.length === 0) return; // default-nothing is valid; it just syncs nothing
    const api = slackClientFor(conn, await tokenFor(conn, ctx), ctx);
    for (const channelId of conn.scope) {
      const info = await api.call<ConversationInfoResponse>("conversations.info", { channel: channelId });
      if (info.channel?.is_archived) throw new ConnectorError("slack", "channel_archived", `channel ${channelId} is archived`);
      if (!info.channel?.is_member) {
        // Public channels can be joined; private ones require an invite the customer performs.
        if (info.channel?.is_private) throw new ConnectorError("slack", "not_in_channel", `invite the app to private channel #${info.channel.name}`);
        await api.call("conversations.join", { channel: channelId });
      }
    }
  },

  async sync(input: SyncInput<SlackConfig>, ctx): Promise<SyncResult> {
    const { connection: conn, kind } = input;
    const cursor: SlackCursor = { ...((input.cursor as SlackCursor | null) ?? {}) };
    const names = new Map(conn.config.channels.map((c) => [c.id, c.name]));
    const retentionDays = conn.config.retentionDays ?? SLACK_DEFAULT_RETENTION_DAYS;

    // Webhook path: one message, already verified and deduped upstream.
    if (kind === "webhook") {
      const ev = input.payload as SlackMessageEvent | undefined;
      if (!ev || !conn.scope.includes(ev.channel)) return { documentsIngested: 0, metricsIngested: 0, cursor, detail: { skipped: "out of scope" } };
      const api = slackClientFor(conn, await tokenFor(conn, ctx), ctx);
      const channel = { id: ev.channel, name: names.get(ev.channel) ?? ev.channel };
      // A reply re-materialises its parent thread document; a top-level message is its own.
      const rootTs = ev.thread_ts ?? ev.ts;
      const replies = ev.thread_ts ? await fetchReplies(api, ev.channel, rootTs) : [];
      const root = replies[0] ?? (ev as SlackMessage);
      const doc = messageToDocument(channel, root, replies.slice(1), conn.site_id);
      const n = doc ? await upsertDocuments(conn, [doc], { retentionDays }, ctx.sql) : 0;
      if (Number(ev.ts) > Number(cursor[ev.channel] ?? 0)) cursor[ev.channel] = ev.ts;
      return { documentsIngested: n, metricsIngested: 0, cursor };
    }

    if (conn.scope.length === 0) return { documentsIngested: 0, metricsIngested: 0, cursor, detail: { skipped: "no channels in scope" } };

    const api = slackClientFor(conn, await tokenFor(conn, ctx), ctx);
    const backfillOldest = String(Math.floor((ctx.now().getTime() - (conn.config.backfillDays ?? SLACK_DEFAULT_BACKFILL_DAYS) * 86_400_000) / 1000));
    let documents = 0;
    const perChannel: Record<string, number> = {};

    for (const channelId of conn.scope) {
      const channel = { id: channelId, name: names.get(channelId) ?? channelId };
      const oldest = kind === "backfill" ? backfillOldest : (cursor[channelId] ?? backfillOldest);
      const history = await fetchChannelHistory(api, channelId, oldest);
      const docs: DocumentInput[] = [];
      let latest = cursor[channelId] ?? "0";
      for (const m of history) {
        if (Number(m.ts) > Number(latest)) latest = m.ts;
        // Only thread parents: replies do not appear in history unless also broadcast.
        const replies = m.reply_count && m.reply_count > 0 ? await fetchReplies(api, channelId, m.ts) : [];
        const doc = messageToDocument(channel, m, replies.slice(1), conn.site_id);
        if (doc) docs.push(doc);
      }
      const n = await upsertDocuments(conn, docs, { retentionDays }, ctx.sql);
      documents += n;
      perChannel[channelId] = n;
      cursor[channelId] = latest;
    }
    return { documentsIngested: documents, metricsIngested: 0, cursor, detail: { perChannel } };
  },

  async disconnect(conn, ctx) {
    // Revoking the bot token invalidates it Slack-side; the row's Vault secret is deleted by the store.
    if (!conn.secret_ref) return;
    const token = await ctx.secrets.get(conn.secret_ref);
    if (!token) return;
    try {
      await slackApi({ token, fetchImpl: ctx.fetchImpl, maxRetries: 0 }).call("auth.revoke");
    } catch {
      // Best effort: an already-revoked token is the desired end state.
    }
  },
};
export * from "./inbound";

export function slackOAuthFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): SlackOAuthConfig {
  const clientId = env.SLACK_CLIENT_ID;
  const clientSecret = env.SLACK_CLIENT_SECRET;
  const redirectUri = env.SLACK_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new ConnectorError("slack", "not_configured", "SLACK_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI not set");
  return { clientId, clientSecret, redirectUri, fetchImpl };
}
