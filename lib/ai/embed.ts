/**
 * Embeddings. One pinned model, recorded per row as `embedding_model` so a
 * later migration can dual-index rather than silently mixing spaces. The
 * OpenAI-compatible shape is used because it is what most vendors expose;
 * the base URL is configurable for that reason.
 */

export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_MODEL = process.env.AEO_EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export function openAiEmbedder(opts: { model?: string; apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}): Embedder {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    id: model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      if (texts.length === 0) return [];
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const out: number[][] = [];
      // The API caps inputs per request; 256 is comfortably under every vendor's limit.
      for (let i = 0; i < texts.length; i += 256) {
        const batch = texts.slice(i, i + 256);
        const res = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: batch, dimensions: EMBEDDING_DIMENSIONS }),
        });
        if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
        const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        const sorted = [...data.data].sort((a, b) => a.index - b.index);
        for (const d of sorted) out.push(d.embedding);
      }
      return out;
    },
  };
}

/**
 * Deterministic bag-of-words embedder for tests and for the degraded path
 * when no embedding key is configured: near-duplicate detection still works
 * on lexical overlap, semantic clustering does not. Records itself as
 * `hash-bow` so rows produced this way are distinguishable.
 */
export function hashEmbedder(dimensions = 256): Embedder {
  return {
    id: "hash-bow",
    dimensions,
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array<number>(dimensions).fill(0);
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          let h = 2166136261;
          for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
          const slot = Math.abs(h) % dimensions;
          v[slot] = (v[slot] ?? 0) + 1;
        }
        return normalize(v);
      });
    },
  };
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function defaultEmbedder(): Embedder {
  return process.env.OPENAI_API_KEY ? openAiEmbedder() : hashEmbedder();
}
