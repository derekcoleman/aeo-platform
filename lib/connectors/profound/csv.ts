/**
 * Profound CSV export → normalised records.
 *
 * The export is the one Profound path most customers can actually use
 * (Growth plan and up); the REST API is Enterprise-only. Column names vary
 * by export screen and have changed across releases, so headers are matched
 * by alias rather than position, and unknown columns are kept in `raw` so a
 * future normaliser can backfill without re-uploading.
 */

export interface ProfoundCitation {
  url: string;
  domain: string;
  /** 1-based order in the answer's source list, when the export carries one. */
  position: number;
}

export interface ProfoundRecord {
  prompt: string;
  /** Engine slug as Profound labels it, lower-cased: "chatgpt", "perplexity", "google_aio", … */
  engine: string;
  /** ISO date (YYYY-MM-DD) the answer was sampled. */
  date: string;
  brandMentioned: boolean | null;
  citations: ProfoundCitation[];
  /** Profound's visibility score for the prompt/engine/date, 0–100 when present. */
  visibility: number | null;
  raw: Record<string, string>;
}

export interface CsvParseResult {
  records: ProfoundRecord[];
  /** Rows dropped with the reason, so an upload never silently loses data. */
  skipped: { line: number; reason: string }[];
  columns: string[];
}

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF, embedded newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank trailing rows.
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

const HEADER_ALIASES: Record<keyof Omit<ProfoundRecord, "raw" | "citations">, string[]> & { citations: string[]; citationPositions: string[] } = {
  prompt: ["prompt", "prompt text", "query", "question"],
  engine: ["engine", "platform", "model", "ai engine", "answer engine", "source engine"],
  date: ["date", "day", "run date", "answered at", "timestamp", "created at"],
  brandMentioned: ["brand mentioned", "mentioned", "brand present", "brand_mentioned", "is mentioned", "mention"],
  visibility: ["visibility", "visibility score", "visibility %", "share of voice", "sov"],
  citations: ["citations", "citation urls", "cited urls", "sources", "source urls", "urls", "citation"],
  citationPositions: ["citation positions", "positions"],
};

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Column index for each known field, by alias. */
export function mapHeaders(header: string[]): Partial<Record<keyof typeof HEADER_ALIASES, number>> {
  const idx: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {};
  const normalized = header.map(normHeader);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof typeof HEADER_ALIASES, string[]][]) {
    for (const a of aliases) {
      const i = normalized.indexOf(a);
      if (i >= 0) {
        idx[field] = i;
        break;
      }
    }
  }
  return idx;
}

export function parseBool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (["true", "yes", "y", "1", "mentioned", "present"].includes(s)) return true;
  if (["false", "no", "n", "0", "not mentioned", "absent", ""].includes(s)) return false;
  return null;
}

/** Accepts YYYY-MM-DD, ISO timestamps, and US M/D/YYYY. Returns YYYY-MM-DD or null. */
export function parseDate(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export function normalizeEngine(v: string | undefined): string {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (/ai overview|aio|google/.test(s)) return "google_aio";
  if (/chatgpt|openai|gpt/.test(s)) return "chatgpt";
  if (/perplexity/.test(s)) return "perplexity";
  if (/gemini/.test(s)) return "gemini";
  if (/copilot|bing/.test(s)) return "copilot";
  if (/claude/.test(s)) return "claude";
  return s.replace(/[^a-z0-9]+/g, "_");
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Citation cells are `;`, `|`, newline or whitespace separated URL lists. */
export function parseCitations(cell: string | undefined, positionsCell?: string): ProfoundCitation[] {
  if (!cell) return [];
  const urls = cell
    .split(/[\n;|]+|\s+(?=https?:\/\/)/)
    .map((u) => u.trim().replace(/^["'\[\]]+|["'\[\]]+$/g, ""))
    .filter((u) => /^https?:\/\//i.test(u));
  const positions = (positionsCell ?? "")
    .split(/[\n;|,\s]+/)
    .map((p) => Number.parseInt(p, 10))
    .filter((p) => Number.isFinite(p));
  const seen = new Set<string>();
  const out: ProfoundCitation[] = [];
  urls.forEach((url, i) => {
    if (seen.has(url)) return;
    seen.add(url);
    const domain = domainOf(url);
    if (!domain) return;
    out.push({ url, domain, position: positions[i] ?? out.length + 1 });
  });
  return out;
}

export function parseProfoundCsv(text: string): CsvParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) return { records: [], skipped: [], columns: [] };
  const header = rows[0]!;
  const idx = mapHeaders(header);
  const missing = (["prompt", "engine", "date"] as const).filter((k) => idx[k] === undefined);
  if (missing.length > 0) throw new Error(`profound csv: missing required column(s): ${missing.join(", ")} (have: ${header.join(", ")})`);

  const records: ProfoundRecord[] = [];
  const skipped: CsvParseResult["skipped"] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const at = (k: keyof typeof idx) => (idx[k] === undefined ? undefined : cells[idx[k]!]);
    const prompt = (at("prompt") ?? "").trim();
    const date = parseDate(at("date"));
    if (!prompt) {
      skipped.push({ line: r + 1, reason: "empty prompt" });
      continue;
    }
    if (!date) {
      skipped.push({ line: r + 1, reason: `unparseable date "${at("date") ?? ""}"` });
      continue;
    }
    const visRaw = at("visibility");
    const vis = visRaw === undefined || visRaw.trim() === "" ? null : Number.parseFloat(visRaw.replace("%", ""));
    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[h] = cells[i] ?? ""));
    records.push({
      prompt,
      engine: normalizeEngine(at("engine")),
      date,
      brandMentioned: parseBool(at("brandMentioned")),
      citations: parseCitations(at("citations"), at("citationPositions")),
      visibility: vis === null || Number.isNaN(vis) ? null : Math.max(0, Math.min(100, vis)),
      raw,
    });
  }
  return { records, skipped, columns: header };
}
