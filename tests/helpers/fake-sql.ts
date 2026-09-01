import type postgres from "postgres";

/**
 * A tagged-template stand-in for `postgres.Sql`. Records every query as
 * `{ text, values }` (with `$n` placeholders) and answers from a handler keyed
 * by a regex on the flattened SQL text. Enough for the store's insert/update/
 * returning shapes without a database.
 */
export interface RecordedQuery {
  text: string;
  values: unknown[];
}

export type FakeSqlHandler = (q: RecordedQuery) => unknown[] | undefined;

export function fakeSql(handlers: [RegExp, FakeSqlHandler][] = []): postgres.Sql & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""), "").replace(/\s+/g, " ").trim();
    const q = { text, values };
    queries.push(q);
    for (const [re, h] of handlers) if (re.test(text)) return h(q) ?? [];
    return [];
  }) as unknown as postgres.Sql & { queries: RecordedQuery[] };
  Object.assign(sql, {
    queries,
    json: (v: unknown) => ({ __json: v }),
    array: (v: unknown) => ({ __array: v }),
    unsafe: async () => [],
    begin: async (fn: (s: postgres.Sql) => Promise<unknown>) => fn(sql),
    end: async () => undefined,
  });
  return sql;
}

/** Sequential uuids for `returning id` handlers. */
export function idSequence(prefix = "00000000-0000-4000-8000-"): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(12, "0")}`;
}
