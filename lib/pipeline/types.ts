import { z } from "zod";

/**
 * Structured shapes that cross pipeline stages. Everything a model returns is
 * validated against one of these before it touches a table; nothing here is
 * free text that another stage has to re-parse.
 */

export const sourceSchema = z.object({
  /** Short stable handle the draft cites as `{{src:key}}`. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  url: z.string().url(),
  publisher: z.string().min(1).max(200).nullable().optional(),
  title: z.string().max(300).nullable().optional(),
  /** Verbatim text that must appear on the page — a string assertion, not a judgment. */
  quote: z.string().min(8).max(600),
});
export type SourceSpec = z.infer<typeof sourceSchema>;

/** A verified brand fact offered to the draft; cited as `{{fact:key}}` and checked at the grounding gate. */
export const briefFactSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  factId: z.guid(),
  type: z.string().min(1).max(40),
  text: z.string().min(1).max(800),
  visibility: z.enum(["public", "internal"]),
});
export type BriefFact = z.infer<typeof briefFactSchema>;

export const intentSchema = z.enum(["comparative", "informational", "howto", "unknown"]);
export type Intent = z.infer<typeof intentSchema>;

/**
 * A brief is structured, not prose. The answer is written first because it is
 * what gets cited; every H2 is a real question; every section names the
 * sources it may cite.
 */
export const briefSpecSchema = z.object({
  headQuestion: z.string().min(5).max(300),
  /** 40–60 word extractable answer to the head question. */
  targetAnswer: z.string().min(40).max(600),
  intent: intentSchema.catch("unknown"),
  title: z.string().min(5).max(120),
  description: z.string().min(20).max(320),
  outline: z
    .array(
      z.object({
        heading: z.string().min(5).max(200),
        goal: z.string().max(400).optional(),
        sourceKeys: z.array(z.string()).max(10).default([]),
      }),
    )
    .min(2)
    .max(12),
  faq: z.array(z.string().min(5).max(300)).max(8).default([]),
  entities: z.array(z.string().min(1).max(100)).max(20).default([]),
  internalLinks: z.array(z.object({ url: z.string().url(), anchor: z.string().min(2).max(120) })).max(10).default([]),
  pov: z.string().max(600).default(""),
  bannedClaims: z.array(z.string().max(200)).max(20).default([]),
  sources: z.array(sourceSchema).max(20).default([]),
  /** Keys the model picked from the verified facts it was offered; resolved into `facts` by code, never by the model. */
  factKeys: z.array(z.string()).max(20).default([]),
  /** The facts the draft may cite, materialised from factKeys + the offered list. */
  facts: z.array(briefFactSchema).max(20).default([]),
  manifestVersionId: z.guid().nullable().default(null),
  /** Article format the topic or the requester asked for; set by code, not the model. */
  format: z.enum(["comparison", "howto", "guide", "listicle", "faq"]).nullable().default(null),
  /** What currently-cited pages look like for this topic; set by code from measure.competitor_pages. */
  structuralTarget: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type BriefSpec = z.infer<typeof briefSpecSchema>;

/** Draft output: markdown body with `{{src:key}}` markers, plus the structured bits JSON-LD needs. */
export const draftOutputSchema = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(20).max(320),
  /** Body markdown. H2/H3 only — the document owns the H1. */
  bodyMd: z.string().min(200),
  faq: z.array(z.object({ question: z.string().min(5).max(300), answer: z.string().min(20).max(800) })).max(8).default([]),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;

export interface ModelRun {
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ApprovalDecision = "approve" | "changes" | "regenerate";
export type ApprovalPolicy = "auto_publish" | "approve_brief" | "approve_post" | "approve_both";

export interface QaGateResult {
  gate: "structure" | "sources" | "grounding" | "mechanics" | "slop";
  passed: boolean;
  detail: Record<string, unknown>;
}

export interface QaReport {
  passed: boolean;
  gates: QaGateResult[];
  /** Which stage a failure routes back to. */
  routeTo: "draft" | "brief" | null;
  /** Human-readable feedback fed into the regenerate prompt. */
  feedback: string[];
}
