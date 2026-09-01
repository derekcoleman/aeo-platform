import { cosine, type Embedder } from "@/lib/ai/embed";
import type { SerpClient, SerpDevice, SerpLocale, SerpTenant } from "@/lib/serp";

/**
 * Demand mining: turn seed terms from the brand brain into a graph of the
 * questions buyers actually ask, phrased how they phrase them.
 *
 * Autocomplete is the cheapest large-scale source of real question phrasing;
 * People Also Ask questions are, almost by definition, extractable-answer
 * targets. Each seed is expanded by modifier and alphabetically, results are
 * expanded again to `depth`, then everything is deduped (exact, then by
 * embedding) and clustered into topics.
 */

export type QuestionSource = "autocomplete" | "paa" | "manual" | "gsc" | "competitor" | "profound";

export interface QuestionNode {
  text: string;
  normalized: string;
  source: QuestionSource;
  seedTerm: string;
  parent: string | null;
  depth: number;
  /** Distinct parent queries that surfaced this question. */
  seenCount: number;
  /** PAA answer context when Google showed one. */
  paaAnswer?: { snippet?: string; sourceUrl?: string };
}

export interface ScoredQuestion extends QuestionNode {
  demandScore: number;
  embedding?: number[];
  clusterIndex?: number;
}

export interface QuestionCluster {
  index: number;
  name: string;
  members: number[];
  centroid?: number[];
}

export interface QuestionGraph {
  questions: ScoredQuestion[];
  clusters: QuestionCluster[];
  stats: { queriesIssued: number; cachedQueries: number; costUsd: number; rawCandidates: number; embeddingModel: string | null };
}

export const QUESTION_MODIFIERS = {
  prefix: ["how", "what", "why", "best", "is", "can", "does", "which", "when", "should"],
  suffix: ["vs", "alternative", "alternatives", "pricing", "cost", "for small business", "for enterprise", "examples", "tools", "software", "review", "reddit"],
} as const;

const QUESTION_STARTS = /^(how|what|why|when|where|which|who|is|are|can|could|does|do|did|should|will|would)\b/i;

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Question-shaped, or comparative — the two intents the pipeline serves. */
export function isQuestionLike(text: string): boolean {
  const t = text.trim();
  if (t.endsWith("?")) return true;
  if (QUESTION_STARTS.test(t)) return true;
  return /\b(vs\.?|versus|alternative|alternatives|compared to|difference between)\b/i.test(t);
}

export function expandSeed(seed: string, opts: { alphabet?: boolean } = {}): string[] {
  const s = seed.trim().toLowerCase();
  const out = new Set<string>([s]);
  for (const p of QUESTION_MODIFIERS.prefix) out.add(`${p} ${s}`);
  for (const x of QUESTION_MODIFIERS.suffix) out.add(`${s} ${x}`);
  if (opts.alphabet) for (const c of "abcdefghijklmnopqrstuvwxyz") out.add(`${s} ${c}`);
  return [...out];
}

export interface BuildOptions {
  seeds: string[];
  locale: SerpLocale;
  device?: SerpDevice;
  /** Recursion depth for re-expanding discovered questions. 2 per the plan. */
  depth?: number;
  /** Hard cap on paid/cached queries issued, so a wide seed set cannot run away. */
  maxQueries?: number;
  /** Expand seeds alphabetically (26 extra autocomplete calls per seed). */
  alphabet?: boolean;
  /** Pull PAA (one SERP call per query) alongside autocomplete. */
  paa?: boolean;
  embedder?: Embedder;
  /** Cosine above this = same question. */
  dedupeThreshold?: number;
  /** Cosine to a cluster centroid above this = same topic. */
  clusterThreshold?: number;
  /** Keep only question-shaped or comparative phrasings. */
  questionsOnly?: boolean;
}

export async function buildQuestionGraph(client: SerpClient, tenant: SerpTenant, opts: BuildOptions): Promise<QuestionGraph> {
  const depth = opts.depth ?? 2;
  const maxQueries = opts.maxQueries ?? 300;
  const device = opts.device ?? "desktop";
  const questionsOnly = opts.questionsOnly ?? true;

  const nodes = new Map<string, QuestionNode>();
  const issued = new Set<string>();
  const stats = { queriesIssued: 0, cachedQueries: 0, costUsd: 0, rawCandidates: 0, embeddingModel: opts.embedder?.id ?? null };

  const add = (text: string, source: QuestionSource, seedTerm: string, parent: string | null, d: number, paaAnswer?: QuestionNode["paaAnswer"]) => {
    stats.rawCandidates += 1;
    const normalized = normalizeQuestion(text);
    if (!normalized || normalized.split(" ").length < 2) return null;
    if (questionsOnly && !isQuestionLike(text)) return null;
    const existing = nodes.get(normalized);
    if (existing) {
      existing.seenCount += 1;
      if (source === "paa" && existing.source !== "paa") existing.source = "paa";
      if (paaAnswer && !existing.paaAnswer) existing.paaAnswer = paaAnswer;
      if (d < existing.depth) existing.depth = d;
      return existing;
    }
    const node: QuestionNode = { text: text.trim(), normalized, source, seedTerm, parent, depth: d, seenCount: 1, paaAnswer };
    nodes.set(normalized, node);
    return node;
  };

  // Frontier: queries to expand at the current depth. Seeds themselves are
  // expanded by modifier; discovered questions are queried as-is.
  let frontier: { query: string; seedTerm: string; parent: string | null }[] = [];
  for (const seed of opts.seeds) {
    for (const q of expandSeed(seed, { alphabet: opts.alphabet })) frontier.push({ query: q, seedTerm: seed, parent: null });
  }

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      const key = normalizeQuestion(f.query);
      if (!key || issued.has(key)) continue;
      if (issued.size >= maxQueries) break;
      issued.add(key);
      const q = { query: f.query, locale: opts.locale, device };

      const ac = await client.autocomplete(q, tenant);
      stats.queriesIssued += 1;
      if (ac.cached) stats.cachedQueries += 1;
      stats.costUsd += ac.cached ? 0 : ac.costUsd;
      for (const s of ac.suggestions) {
        const n = add(s, "autocomplete", f.seedTerm, f.parent ?? f.query, d);
        if (n && n.seenCount === 1) next.push({ query: n.text, seedTerm: f.seedTerm, parent: n.text });
      }

      if (opts.paa) {
        const serp = await client.serp(q, tenant);
        stats.queriesIssued += 1;
        if (serp.cached) stats.cachedQueries += 1;
        stats.costUsd += serp.cached ? 0 : serp.costUsd;
        for (const p of serp.paa) {
          const n = add(p.question, "paa", f.seedTerm, f.parent ?? f.query, d, { snippet: p.answerSnippet, sourceUrl: p.sourceUrl });
          if (n && n.seenCount === 1) next.push({ query: n.text, seedTerm: f.seedTerm, parent: n.text });
        }
      }
    }
    frontier = next;
  }

  let questions: ScoredQuestion[] = [...nodes.values()].map((n) => ({ ...n, demandScore: demandScore(n) }));
  let clusters: QuestionCluster[] = [];

  if (opts.embedder && questions.length > 0) {
    const vectors = await opts.embedder.embed(questions.map((q) => q.text));
    questions.forEach((q, i) => (q.embedding = vectors[i]));
    questions = dedupeByEmbedding(questions, opts.dedupeThreshold ?? 0.92);
    clusters = clusterQuestions(questions, opts.clusterThreshold ?? 0.75);
  }

  questions.sort((a, b) => b.demandScore - a.demandScore || a.depth - b.depth || a.text.localeCompare(b.text));
  return { questions, clusters, stats };
}

/**
 * Demand from discovery alone: how many distinct queries surfaced this
 * phrasing (Google only suggests what people type), a PAA bonus (Google
 * chose to answer it), and a depth penalty (far from the seed = long tail).
 * GSC impressions replace this with ground truth when the connector is on.
 */
export function demandScore(n: Pick<QuestionNode, "seenCount" | "source" | "depth">): number {
  const base = Math.log2(1 + n.seenCount) * 10;
  const paa = n.source === "paa" ? 8 : 0;
  const depthPenalty = (n.depth - 1) * 4;
  return Math.round(Math.max(1, base + paa - depthPenalty) * 100) / 100;
}

/** Keep the higher-demand phrasing of any pair above the threshold; merge counts. */
export function dedupeByEmbedding<T extends ScoredQuestion>(items: T[], threshold: number): T[] {
  const sorted = [...items].sort((a, b) => b.demandScore - a.demandScore);
  const kept: T[] = [];
  for (const item of sorted) {
    if (!item.embedding) {
      kept.push(item);
      continue;
    }
    const dup = kept.find((k) => k.embedding && cosine(k.embedding, item.embedding!) >= threshold);
    if (dup) {
      dup.seenCount += item.seenCount;
      dup.demandScore = demandScore(dup);
    } else {
      kept.push(item);
    }
  }
  return kept;
}

/**
 * Greedy leader clustering: in demand order, join the first cluster whose
 * centroid is within threshold, else start one. O(n·k), deterministic, and
 * good enough for a few thousand questions per site; the cluster name is the
 * highest-demand member.
 */
export function clusterQuestions(items: ScoredQuestion[], threshold: number): QuestionCluster[] {
  const clusters: (QuestionCluster & { sum: number[] })[] = [];
  const order = items.map((q, i) => i).sort((a, b) => items[b]!.demandScore - items[a]!.demandScore);
  for (const i of order) {
    const q = items[i]!;
    if (!q.embedding) continue;
    let best: (typeof clusters)[number] | null = null;
    let bestSim = threshold;
    for (const c of clusters) {
      const sim = cosine(c.centroid!, q.embedding);
      if (sim >= bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best) {
      best.members.push(i);
      best.sum = best.sum.map((x, j) => x + q.embedding![j]!);
      const n = best.members.length;
      best.centroid = best.sum.map((x) => x / n);
    } else {
      clusters.push({ index: clusters.length, name: q.text, members: [i], centroid: [...q.embedding], sum: [...q.embedding] });
    }
    q.clusterIndex = best ? best.index : clusters.length - 1;
  }
  return clusters.map(({ sum: _sum, ...c }) => c);
}
