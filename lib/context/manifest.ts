import type postgres from "postgres";
import { z } from "zod";
import type { TextModel } from "@/lib/ai/model";
import { appDb } from "@/lib/db/app";
import { runJsonTask } from "@/lib/pipeline/model";
import type { ModelRun } from "@/lib/pipeline/types";
import { listVerifiedFacts, renderFact } from "./facts";

/**
 * The manifesto: a versioned structured document above the three storage
 * layers. Category POV, contrarian takes, ICP, voice do/don't pairs, banned
 * phrases, competitor stance, approved proof points, legal no-gos. Every
 * brief and version pins the manifest id it was generated under, so a piece
 * is reproducible and "what changed" is a diff of two jsonb rows.
 *
 * v1 drafts it from verified facts; the AI-journalist interview that
 * produces a richer one is a later slice. Activation is always a human act.
 */

export const MANIFEST_DOC_VERSION = 1;
export const MANIFEST_DRAFT_PROMPT_VERSION = "manifest.draft.v1";

const short = (max: number) => z.string().max(max);

export const manifestDocSchema = z.object({
  docVersion: z.literal(1).catch(1),
  brand: z.object({ name: short(120), oneLiner: short(300).default(""), category: short(120).default("") }),
  categoryPov: short(1500).default(""),
  contrarianTakes: z.array(short(400)).max(10).default([]),
  icp: z.array(z.object({ persona: short(120), jobsToBeDone: z.array(short(200)).max(8).default([]), pains: z.array(short(200)).max(8).default([]) })).max(6).default([]),
  voice: z.object({ summary: short(600).default(""), pairs: z.array(z.object({ do: short(200), dont: short(200) })).max(12).default([]) }).default({ summary: "", pairs: [] }),
  bannedPhrases: z.array(short(80)).max(40).default([]),
  competitors: z.array(z.object({ name: short(120), stance: short(400).default(""), neverSay: z.array(short(200)).max(6).default([]) })).max(12).default([]),
  proofPoints: z.array(z.object({ text: short(300), factId: z.guid().nullable().optional() })).max(20).default([]),
  legalNoGos: z.array(short(200)).max(20).default([]),
  terminology: z.array(z.object({ term: short(80), meaning: short(300), avoid: z.array(short(80)).max(6).default([]) })).max(30).default([]),
});
export type ManifestDoc = z.infer<typeof manifestDocSchema>;

export interface ManifestRow {
  id: string;
  org_id: string;
  site_id: string | null;
  version: number;
  status: "draft" | "active" | "archived";
  doc: ManifestDoc;
  activated_at: string | Date | null;
}


export async function insertManifest(
  input: { orgId: string; siteId?: string | null; doc: ManifestDoc; source: Record<string, unknown>; run?: ModelRun | null; createdBy?: string | null },
  sql: postgres.Sql = appDb(),
): Promise<ManifestRow> {
  const doc = manifestDocSchema.parse(input.doc);
  const [row] = await sql<ManifestRow[]>`
    insert into context.brand_manifests (org_id, site_id, version, status, doc, source, model_run, created_by)
    values (${input.orgId}, ${input.siteId ?? null},
            (select coalesce(max(version), 0) + 1 from context.brand_manifests where org_id = ${input.orgId}),
            'draft', ${sql.json(doc as never)}, ${sql.json(input.source as never)}, ${input.run ? sql.json(input.run as never) : null}, ${input.createdBy ?? null})
    returning id, org_id, site_id, version, status, doc, activated_at`;
  if (!row) throw new Error("manifest insert returned no row");
  return row;
}

/** Archive the current active manifest for the same scope, then activate this one. One transaction, so the partial unique never trips. */
export async function activateManifest(orgId: string, manifestId: string, sql: postgres.Sql = appDb()): Promise<ManifestRow | null> {
  return sql.begin(async (tx) => {
    const [target] = await tx<ManifestRow[]>`select id, org_id, site_id, version, status, doc, activated_at from context.brand_manifests where id = ${manifestId} and org_id = ${orgId} for update`;
    if (!target || target.status === "archived") return null;
    await tx`
      update context.brand_manifests set status = 'archived', updated_at = now()
      where org_id = ${orgId} and status = 'active' and site_id is not distinct from ${target.site_id} and id <> ${manifestId}`;
    const [row] = await tx<ManifestRow[]>`
      update context.brand_manifests set status = 'active', activated_at = now(), updated_at = now()
      where id = ${manifestId} and org_id = ${orgId}
      returning id, org_id, site_id, version, status, doc, activated_at`;
    return row ?? null;
  });
}

/** The site-specific active manifest if there is one, else the org-wide one, else null. */
export async function loadActiveManifest(orgId: string, siteId: string | null, sql: postgres.Sql = appDb()): Promise<ManifestRow | null> {
  const rows = await sql<ManifestRow[]>`
    select id, org_id, site_id, version, status, doc, activated_at from context.brand_manifests
    where org_id = ${orgId} and status = 'active' and (site_id is null or site_id = ${siteId})
    order by (site_id is not null) desc, version desc limit 1`;
  const row = rows[0];
  return row ? { ...row, doc: manifestDocSchema.parse(row.doc) } : null;
}

export async function loadManifest(orgId: string, id: string, sql: postgres.Sql = appDb()): Promise<ManifestRow | null> {
  const [row] = await sql<ManifestRow[]>`select id, org_id, site_id, version, status, doc, activated_at from context.brand_manifests where id = ${id} and org_id = ${orgId}`;
  return row ? { ...row, doc: manifestDocSchema.parse(row.doc) } : null;
}

export type ManifestSection = "brand" | "pov" | "icp" | "voice" | "competitors" | "proof" | "legal" | "terminology";
const ALL_SECTIONS: ManifestSection[] = ["brand", "pov", "icp", "voice", "competitors", "proof", "legal", "terminology"];

/** The manifesto as a prompt block: bounded, section-selectable, deterministic for the same doc. */
export function manifestPromptBlock(doc: ManifestDoc, opts: { maxChars?: number; sections?: ManifestSection[] } = {}): string {
  const want = new Set(opts.sections ?? ALL_SECTIONS);
  const parts: string[] = [];
  if (want.has("brand")) parts.push(`Brand: ${doc.brand.name}${doc.brand.category ? ` — ${doc.brand.category}` : ""}${doc.brand.oneLiner ? `. ${doc.brand.oneLiner}` : ""}`);
  if (want.has("pov") && (doc.categoryPov || doc.contrarianTakes.length)) {
    parts.push([doc.categoryPov ? `Category point of view: ${doc.categoryPov}` : "", ...doc.contrarianTakes.map((t) => `- Contrarian take: ${t}`)].filter(Boolean).join("\n"));
  }
  if (want.has("icp") && doc.icp.length) {
    parts.push(`ICP:\n${doc.icp.map((p) => `- ${p.persona}${p.pains.length ? ` — pains: ${p.pains.join("; ")}` : ""}${p.jobsToBeDone.length ? ` — jobs: ${p.jobsToBeDone.join("; ")}` : ""}`).join("\n")}`);
  }
  if (want.has("voice") && (doc.voice.summary || doc.voice.pairs.length || doc.bannedPhrases.length)) {
    parts.push(
      [
        doc.voice.summary ? `Voice: ${doc.voice.summary}` : "Voice:",
        ...doc.voice.pairs.map((p) => `- Do: ${p.do} / Don't: ${p.dont}`),
        doc.bannedPhrases.length ? `Never use these phrases: ${doc.bannedPhrases.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (want.has("competitors") && doc.competitors.length) {
    parts.push(`Competitors:\n${doc.competitors.map((c) => `- ${c.name}: ${c.stance || "no stated stance"}${c.neverSay.length ? ` (never say: ${c.neverSay.join("; ")})` : ""}`).join("\n")}`);
  }
  if (want.has("proof") && doc.proofPoints.length) parts.push(`Approved proof points:\n${doc.proofPoints.map((p) => `- ${p.text}`).join("\n")}`);
  if (want.has("legal") && doc.legalNoGos.length) parts.push(`Legal no-gos:\n${doc.legalNoGos.map((l) => `- ${l}`).join("\n")}`);
  if (want.has("terminology") && doc.terminology.length) {
    parts.push(`Terminology:\n${doc.terminology.map((t) => `- "${t.term}": ${t.meaning}${t.avoid.length ? ` (not: ${t.avoid.join(", ")})` : ""}`).join("\n")}`);
  }
  const block = parts.join("\n\n");
  const max = opts.maxChars ?? 6000;
  return block.length > max ? `${block.slice(0, max - 1)}…` : block;
}

export const MIN_FACTS_FOR_DRAFT = 3;

function manifestDraftSystemPrompt(): string {
  return [
    "You are a brand journalist writing the first draft of a company manifesto from VERIFIED facts only. Return strict JSON matching the schema given.",
    "Do not invent capabilities, customers, numbers or competitor claims. Where the facts are silent, leave the field empty rather than fill it with generic marketing language.",
    "categoryPov: one paragraph on how this company sees its category, in its own terms. contrarianTakes: positions a generic competitor could not take, each traceable to a fact.",
    "voice.pairs: concrete do/don't pairs derived from the terminology and positioning facts. bannedPhrases: hype words this company should avoid.",
    "proofPoints: quote facts of type product_capability, customer_proof, metric, integration or launch with visibility public; set factId to the id given. Never cite an internal fact as a proof point.",
    "competitors: from competitor_claim facts only, with a neutral stance and a neverSay list for anything unverifiable.",
  ].join("\n");
}

/**
 * Draft a manifesto from the org's verified facts. Returns null when there
 * is too little to say — a manifesto invented from three Slack messages is
 * worse than none. The row is inserted as a draft; a human activates it.
 */
export async function draftManifestFromFacts(
  model: TextModel,
  scope: { orgId: string; siteId?: string | null; brand: { name: string; domain?: string | null } },
  sql: postgres.Sql = appDb(),
): Promise<ManifestRow | null> {
  const facts = await listVerifiedFacts(scope.orgId, { siteId: scope.siteId ?? null, limit: 120 }, sql);
  if (facts.length < MIN_FACTS_FOR_DRAFT) return null;
  const listed = facts.map((f) => `- [${f.id}] (${f.type}, ${f.visibility}) ${renderFact(f)}`).join("\n");
  const schema = manifestDocSchema.parse({ brand: { name: scope.brand.name } });
  const prompt = [
    `Company: ${scope.brand.name}${scope.brand.domain ? ` (${scope.brand.domain})` : ""}`,
    `Verified facts (id, type, visibility):\n${listed}`,
    `Return JSON with exactly this shape (empty arrays/strings where the facts are silent):\n${JSON.stringify(schema, null, 2)}`,
  ].join("\n\n");
  const { value, run } = await runJsonTask(
    "context.manifest.draft",
    model,
    { system: manifestDraftSystemPrompt(), prompt, promptVersion: MANIFEST_DRAFT_PROMPT_VERSION, maxTokens: 6000, temperature: 0.3 },
    manifestDocSchema,
    { orgId: scope.orgId, siteId: scope.siteId ?? null },
    sql,
  );
  // A proof point that names a fact id we did not offer (or an internal one) is dropped, not trusted.
  const publicIds = new Set(facts.filter((f) => f.visibility === "public").map((f) => f.id));
  const doc: ManifestDoc = {
    ...value,
    brand: { ...value.brand, name: value.brand.name || scope.brand.name },
    proofPoints: value.proofPoints.filter((p) => !p.factId || publicIds.has(p.factId)),
  };
  return insertManifest({ orgId: scope.orgId, siteId: scope.siteId ?? null, doc, source: { kind: "facts", factIds: facts.map((f) => f.id) }, run }, sql);
}
