import type postgres from "postgres";
import type { TextModel } from "@/lib/ai/model";
import { factKey, renderFact } from "@/lib/context/facts";
import { manifestPromptBlock } from "@/lib/context/manifest";
import { formatContextBlock, retrieveContext } from "@/lib/context/retrieve";
import { appDb } from "@/lib/db/app";
import { runJsonTask } from "./model";
import { briefSpecSchema, type BriefFact, type BriefSpec, type ModelRun } from "./types";

/**
 * Stage 2: the brief. Structured, not prose, and the 40–60 word target answer
 * is written first because it is what gets cited. In the managed tier this is
 * the primary human gate — 90 seconds that determine most of the output.
 *
 * Grounding comes from three places: the opportunity's evidence and the
 * demand miner's related questions, the site's own pages, and the brand
 * brain (`retrieveContext`) — the active manifesto, verified facts the draft
 * may cite, and internal context for background. The brain is enrichment:
 * when it is empty or unreachable the prompt is byte-identical to one
 * without it, so a tenant with no connectors still gets a brief.
 */

export const BRIEF_PROMPT_VERSION = "brief.v2";

export interface BriefBrain {
  /** Verified facts offered to the model, already keyed for `{{fact:key}}`. */
  facts: BriefFact[];
  /** Manifesto prompt block, or null when no manifest is active. */
  manifest: string | null;
  manifestVersionId: string | null;
  /** Internal chunks with provenance, background only. */
  contextBlock: string;
}

export interface BriefContext {
  opportunity: { title: string; targetQuery: string; source: string; evidence: Record<string, unknown> };
  site: { domain: string; pathPrefix: string; organizationName: string };
  /** Real buyer questions (PAA / autocomplete children) for the outline and FAQ. */
  relatedQuestions: string[];
  /** Already-published pages to link to, including money pages. */
  existingPages: { url: string; title: string }[];
  /** Brand brain retrieval; null or absent when the org has none. */
  brain?: BriefBrain | null;
  /** A reviewer's note when regenerating. */
  note?: string | null;
  previous?: BriefSpec | null;
}

export function briefSystemPrompt(): string {
  return [
    "You are the editor-in-chief for a B2B software company's resources section, planning one article that should be cited by AI answer engines (Google AI Overviews, ChatGPT, Perplexity).",
    "You write briefs as strict JSON matching the schema the user gives you. No prose outside the JSON.",
    "Rules:",
    "- targetAnswer: a 40–60 word, self-contained, directly quotable answer to headQuestion. Write it first. No marketing language.",
    "- outline: 4–8 sections; EVERY heading is a real question a buyer would type, taken from the related questions where they fit. Never invent jargon questions.",
    "- sources: only include a source if you are certain the URL exists AND the quote is verbatim from that page. An unverifiable source is worse than none — the draft is fact-checked mechanically and a failed quote check rejects it. Leave the list empty if unsure.",
    "- internalLinks: only from the existing pages provided.",
    "- bannedClaims: things this article must not assert (unverifiable superlatives, competitor claims without evidence, customer names).",
    "- pov: one paragraph on what this company can say that a generic competitor could not, based on the evidence given.",
    "- factKeys: when verified brand facts are offered, pick the ones the article should rest on (prefer public ones; an internal fact shapes the POV but cannot be cited). Never invent a key.",
    "- If a brand manifesto is given, the brief must respect its voice rules, banned phrases, competitor stance and legal no-gos; use its terminology.",
  ].join("\n");
}

export function briefPrompt(ctx: BriefContext): string {
  const schema = {
    headQuestion: "string (5–300 chars)",
    targetAnswer: "string (40–60 words)",
    intent: "comparative | informational | howto | unknown",
    title: "string (5–120 chars, question-form or benefit-led, no clickbait)",
    description: "string (20–320 chars; the meta description)",
    outline: [{ heading: "string (question form)", goal: "string (what the reader learns)", sourceKeys: ["string"] }],
    faq: ["string (question)"],
    entities: ["string"],
    internalLinks: [{ url: "string (from existing pages)", anchor: "string" }],
    pov: "string",
    bannedClaims: ["string"],
    sources: [{ key: "string (kebab-case, e.g. gartner-2026)", url: "string", publisher: "string", title: "string", quote: "string (verbatim, 8–600 chars)" }],
    factKeys: ["string (only keys from the verified facts offered; empty if none offered)"],
  };
  const parts = [
    `Company: ${ctx.site.organizationName} (${ctx.site.domain}${ctx.site.pathPrefix})`,
    `Opportunity (${ctx.opportunity.source}): ${ctx.opportunity.title}`,
    `Target query: ${ctx.opportunity.targetQuery}`,
    `Evidence: ${JSON.stringify(ctx.opportunity.evidence)}`,
    ctx.relatedQuestions.length ? `Related buyer questions:\n${ctx.relatedQuestions.map((q) => `- ${q}`).join("\n")}` : "Related buyer questions: none found.",
    ctx.existingPages.length ? `Existing pages to link to:\n${ctx.existingPages.map((p) => `- ${p.title} — ${p.url}`).join("\n")}` : "Existing pages: none yet.",
  ];
  if (ctx.brain?.manifest) parts.push(`Brand manifesto:\n${ctx.brain.manifest}`);
  if (ctx.brain?.facts.length) {
    parts.push(`Verified brand facts (key → fact; only public ones may be cited in the article):\n${ctx.brain.facts.map((f) => `- ${f.key} [${f.type}, ${f.visibility}] ${f.text}`).join("\n")}`);
  }
  if (ctx.brain?.contextBlock) parts.push(ctx.brain.contextBlock);
  if (ctx.previous) parts.push(`Previous brief (revise it, do not start over):\n${JSON.stringify(ctx.previous)}`);
  if (ctx.note) parts.push(`Reviewer note — this takes priority over everything above:\n${ctx.note}`);
  parts.push(`Return JSON with exactly this shape:\n${JSON.stringify(schema, null, 2)}`);
  return parts.join("\n\n");
}

export async function generateBrief(
  model: TextModel,
  ctx: BriefContext,
  scope: { orgId: string; siteId: string },
  sql: postgres.Sql = appDb(),
): Promise<{ spec: BriefSpec; run: ModelRun }> {
  const { value, run } = await runJsonTask("pipeline.brief", model, { system: briefSystemPrompt(), prompt: briefPrompt(ctx), promptVersion: BRIEF_PROMPT_VERSION, temperature: 0.4 }, briefSpecSchema, scope, sql);
  return { spec: materializeFacts(value, ctx.brain ?? null), run };
}

export const MAX_BRIEF_FACTS = 12;

/**
 * The model chooses keys; code resolves them against the offered list so a
 * hallucinated key never becomes a fact. With no choice made, every offered
 * public fact (capped) is available to the draft.
 */
export function materializeFacts(spec: BriefSpec, brain: BriefBrain | null): BriefSpec {
  if (!brain) return { ...spec, factKeys: [], facts: [], manifestVersionId: null };
  const offered = new Map(brain.facts.map((f) => [f.key, f]));
  const chosen = spec.factKeys.map((k) => offered.get(k)).filter((f): f is BriefFact => !!f);
  const facts = (chosen.length ? chosen : brain.facts.filter((f) => f.visibility === "public")).slice(0, MAX_BRIEF_FACTS);
  return { ...spec, factKeys: facts.map((f) => f.key), facts, manifestVersionId: brain.manifestVersionId };
}

/** Retrieve the brain for a brief. Never throws: an empty or failing brain is a brief without one, and the failure is logged. */
export async function loadBriefBrain(scope: { orgId: string; siteId: string }, query: string, sql: postgres.Sql = appDb()): Promise<BriefBrain | null> {
  try {
    const ctx = await retrieveContext(scope, query, { sql });
    if (!ctx.manifest && ctx.facts.length === 0 && ctx.chunks.length === 0) return null;
    return {
      facts: ctx.facts.map((f) => ({ key: factKey(f), factId: f.id, type: f.type, text: renderFact(f), visibility: f.visibility })),
      manifest: ctx.manifest ? manifestPromptBlock(ctx.manifest.doc) : null,
      manifestVersionId: ctx.manifest?.id ?? null,
      contextBlock: formatContextBlock({ ...ctx, facts: [] }, { includeManifest: false }),
    };
  } catch (e) {
    console.warn(`[pipeline] brand brain retrieval failed for org ${scope.orgId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function loadBriefContext(
  opportunity: { org_id: string; site_id: string; question_id: string | null; title: string; target_query: string; source: string; evidence: Record<string, unknown> },
  sql: postgres.Sql = appDb(),
): Promise<BriefContext> {
  const [site] = await sql<{ canonical_domain: string; path_prefix: string; organization: { name?: string } | null }[]>`
    select s.canonical_domain, s.path_prefix, c.organization
    from app.sites s left join content.site_render_config c on c.site_id = s.id
    where s.id = ${opportunity.site_id}`;
  if (!site) throw new Error(`site ${opportunity.site_id} not found`);
  const related = opportunity.question_id
    ? await sql<{ text: string }[]>`
        select text from measure.questions
        where site_id = ${opportunity.site_id}
          and (parent_question_id = ${opportunity.question_id}
               or cluster_id = (select cluster_id from measure.questions where id = ${opportunity.question_id} and cluster_id is not null))
          and id <> ${opportunity.question_id}
        order by demand_score desc limit 12`
    : [];
  const pages = await sql<{ url: string; title: string }[]>`
    select coalesce(i.canonical_url, p.path) as url, coalesce(i.title, p.head->>'title', p.path) as title
    from content.published_pages p left join content.content_items i on i.id = p.content_item_id
    where p.site_id = ${opportunity.site_id}
    order by p.updated_at desc limit 25`;
  const brain = await loadBriefBrain({ orgId: opportunity.org_id, siteId: opportunity.site_id }, `${opportunity.title} ${opportunity.target_query}`, sql);
  return {
    opportunity: { title: opportunity.title, targetQuery: opportunity.target_query, source: opportunity.source, evidence: opportunity.evidence },
    site: { domain: site.canonical_domain, pathPrefix: site.path_prefix, organizationName: site.organization?.name ?? site.canonical_domain },
    relatedQuestions: related.map((r) => r.text),
    existingPages: pages,
    brain,
  };
}

export interface BriefRow {
  id: string;
  org_id: string;
  site_id: string;
  opportunity_id: string | null;
  version: number;
  status: "drafted" | "pending_approval" | "approved" | "changes_requested" | "superseded";
  spec: BriefSpec;
  target_answer: string;
}

export async function insertBrief(
  input: { siteId: string; opportunityId: string | null; version: number; spec: BriefSpec; run: ModelRun },
  sql: postgres.Sql = appDb(),
): Promise<{ id: string }> {
  const [row] = await sql<{ id: string }[]>`
    insert into content.briefs (site_id, opportunity_id, version, status, spec, target_answer, model_run, manifest_version_id)
    values (${input.siteId}, ${input.opportunityId}, ${input.version}, 'drafted', ${sql.json(input.spec as never)}, ${input.spec.targetAnswer}, ${sql.json(input.run as never)}, ${input.spec.manifestVersionId ?? null})
    returning id`;
  if (!row) throw new Error("brief insert returned no row");
  return row;
}

export async function setBriefStatus(id: string, status: BriefRow["status"], sql: postgres.Sql = appDb()): Promise<void> {
  await sql`update content.briefs set status = ${status}, updated_at = now() where id = ${id}`;
}

export async function loadBrief(id: string, sql: postgres.Sql = appDb()): Promise<BriefRow | null> {
  const [row] = await sql<BriefRow[]>`select id, org_id, site_id, opportunity_id, version, status, spec, target_answer from content.briefs where id = ${id}`;
  return row ? { ...row, spec: briefSpecSchema.parse(row.spec) } : null;
}
