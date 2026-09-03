import type { ChunkInput, ContextDocument } from "./types";

/**
 * Structure-aware chunking. A chunk is the unit retrieval returns and the
 * unit a draft can be grounded in, so it has to read on its own: Slack
 * threads keep their root message on every continuation, headed documents
 * split on headings, and everything else falls back to a sliding window
 * that breaks on sentence boundaries with a small overlap.
 *
 * Sizes are in characters (~4 chars per token for English) so the module
 * stays free of a tokenizer dependency; `estimateTokens` records the
 * approximation on the row for budgeting.
 */

export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_MAX_CHARS = 2000;
export const CHUNK_OVERLAP_CHARS = 150;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type Piece = Pick<ChunkInput, "text" | "metadata">;

function finalize(pieces: Piece[]): ChunkInput[] {
  return pieces
    .map((p) => ({ ...p, text: p.text.trim() }))
    .filter((p) => p.text.length > 0)
    .map((p, i) => ({ ordinal: i, text: p.text, tokenEstimate: estimateTokens(p.text), metadata: p.metadata }));
}

/** Split on sentence ends, then hard-split anything still over the cap. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const s of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)) {
    if (s.length <= CHUNK_MAX_CHARS) {
      out.push(s);
      continue;
    }
    for (let i = 0; i < s.length; i += CHUNK_MAX_CHARS) out.push(s.slice(i, i + CHUNK_MAX_CHARS));
  }
  return out.filter((s) => s.trim().length > 0);
}

/**
 * Sliding window over sentences: fill to the target, carry the tail of the
 * previous chunk forward as overlap so a claim split across a boundary is
 * still retrievable from at least one chunk in full.
 */
export function chunkWindow(text: string, metadata: Record<string, unknown> = {}): ChunkInput[] {
  const parts = sentences(text);
  const pieces: Piece[] = [];
  let buf = "";
  for (const s of parts) {
    if (buf && buf.length + 1 + s.length > CHUNK_TARGET_CHARS) {
      pieces.push({ text: buf, metadata });
      const tail = buf.slice(-CHUNK_OVERLAP_CHARS);
      const cut = tail.search(/\s/);
      buf = cut >= 0 ? tail.slice(cut + 1) : "";
    }
    buf = buf ? `${buf} ${s}` : s;
  }
  if (buf) pieces.push({ text: buf, metadata });
  return finalize(pieces);
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Markdown-ish documents: one chunk per heading section, each prefixed with its heading path; long sections window. */
export function chunkByHeadings(text: string, metadata: Record<string, unknown> = {}): ChunkInput[] {
  const lines = text.split(/\r?\n/);
  const sections: { path: string[]; body: string[] }[] = [{ path: [], body: [] }];
  const path: { level: number; title: string }[] = [];
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (!m) {
      sections[sections.length - 1]!.body.push(line);
      continue;
    }
    const level = m[1]!.length;
    while (path.length && path[path.length - 1]!.level >= level) path.pop();
    path.push({ level, title: m[2]! });
    sections.push({ path: path.map((p) => p.title), body: [] });
  }
  const pieces: Piece[] = [];
  for (const s of sections) {
    const body = s.body.join("\n").trim();
    if (!body) continue;
    const prefix = s.path.length ? `${s.path.join(" > ")}\n\n` : "";
    const meta = { ...metadata, headingPath: s.path };
    if (prefix.length + body.length <= CHUNK_MAX_CHARS) {
      pieces.push({ text: prefix + body, metadata: meta });
      continue;
    }
    for (const w of chunkWindow(body, meta)) pieces.push({ text: prefix + w.text, metadata: meta });
  }
  return finalize(pieces);
}

/** The Slack connector renders a reply as "\n  ↳ <user> text"; the arrow is the boundary we split on. */
export const SLACK_REPLY_SEP = "\n  ↳ ";

/**
 * Slack threads as ingested by the connector: a root line then reply lines.
 * A thread that fits is one chunk. A long one splits on reply boundaries,
 * and every continuation repeats the root line so the chunk still says what
 * the conversation was about.
 */
export function chunkSlackThread(text: string, metadata: Record<string, unknown> = {}): ChunkInput[] {
  if (text.length <= CHUNK_MAX_CHARS) return finalize([{ text, metadata }]);
  const [root = "", ...replies] = text.split(SLACK_REPLY_SEP);
  const rootHeader = `${root.slice(0, 400)}${root.length > 400 ? "..." : ""} (thread continued)`;
  const pieces: Piece[] = [];
  let buf = root;
  let continuation = false;
  for (const r of replies) {
    if (buf.length + SLACK_REPLY_SEP.length + r.length > CHUNK_TARGET_CHARS && buf.trim().length > 0) {
      pieces.push({ text: buf, metadata: { ...metadata, continuation } });
      buf = rootHeader;
      continuation = true;
    }
    buf = `${buf}${SLACK_REPLY_SEP}${r}`;
  }
  if (buf.trim()) pieces.push({ text: buf, metadata: { ...metadata, continuation } });
  // A single reply can exceed the cap; window those.
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.text.length <= CHUNK_MAX_CHARS) out.push(p);
    else for (const w of chunkWindow(p.text, p.metadata)) out.push(w);
  }
  return finalize(out);
}

function hasHeadings(text: string): boolean {
  let n = 0;
  for (const line of text.split(/\r?\n/)) if (HEADING_RE.test(line) && ++n >= 2) return true;
  return false;
}

/** Dispatch by document kind, then by shape. Transcript (speaker-turn) chunking lands with the Gong connector. */
export function chunkDocument(doc: Pick<ContextDocument, "kind" | "text" | "title" | "provider">): ChunkInput[] {
  const base = { kind: doc.kind, provider: doc.provider, ...(doc.title ? { title: doc.title } : {}) };
  const text = doc.text.trim();
  if (!text) return [];
  if (doc.kind === "slack_thread" || doc.kind === "slack_message") return chunkSlackThread(text, base);
  if (hasHeadings(text)) return chunkByHeadings(text, base);
  const chunks = chunkWindow(text, base);
  // The title rides on every chunk so a window from the middle of an export still says what it is from.
  return doc.title && !text.startsWith(doc.title) ? chunks.map((c) => ({ ...c, text: `${doc.title}\n\n${c.text}` })) : chunks;
}
