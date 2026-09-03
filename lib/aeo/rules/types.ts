import type { Doc } from "@/lib/audit/html";
import type { Priority, RecommendationCategory } from "@/lib/audit/types";

/**
 * The shared rule registry: one set of named, individually scored, mostly
 * deterministic rules consumed by (1) the audit, (2) the pipeline's
 * pre-publish structural linter, and (3) the research stage's teardown of
 * currently-cited pages. Same input shape, same scores, three consumers.
 */

export interface PageInput {
  url: string;
  html: string;
  $: Doc;
  markdown: string;
  /** Optional response headers (audit has them; the linter does not). */
  headers?: Headers;
  /** Hint from the brief: comparative intent requires a table. */
  intent?: "comparative" | "informational" | "howto" | "unknown";
  now?: Date;
}

export interface RuleFinding {
  key: string;
  title: string;
  passed: boolean;
  score: number;
  maxScore: number;
  /** Not applicable to this page (e.g. comparison_table on non-comparative intent). Excluded from totals. */
  notApplicable?: boolean;
  evidence: Record<string, unknown>;
  recommendation?: string;
}

export interface PageRule {
  key: string;
  title: string;
  description: string;
  maxScore: number;
  evaluate(page: PageInput): RuleFinding;
}

export interface SiteRecommendation {
  ruleKey: string;
  category: RecommendationCategory;
  priority: Priority;
  title: string;
  description: string;
  impact: string;
  evidence?: Record<string, unknown>;
}
