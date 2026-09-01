import type { ZodType } from "zod";

/**
 * Parse a model's JSON reply and validate it against a schema.
 *
 * Replaces the JSON.parse → `/\{[\s\S]*\}/` regex → hand-rolled clamp block
 * that gtm-agents copy-pasted into four scorers. Clamping belongs in the
 * schema (`z.number().min(0).max(30)` with `.catch()`), not in the parser.
 */
export class ScoredJsonError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "ScoredJsonError";
  }
}

export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;
  const start = candidate.search(/[{[]/);
  if (start < 0) return null;
  // Walk to the matching close bracket so trailing prose doesn't break parsing.
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === close) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

export function parseScoredJson<T>(text: string, schema: ZodType<T>): T {
  const json = extractJsonObject(text);
  if (!json) throw new ScoredJsonError("no JSON object in model output", text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ScoredJsonError(`invalid JSON: ${(e as Error).message}`, text);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ScoredJsonError(`schema mismatch: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, text);
  }
  return result.data;
}
