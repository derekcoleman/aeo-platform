import type postgres from "postgres";

/**
 * A tagged-template stand-in for `postgres.Sql`. Records every query as
 * `{ text, values }` (with `$n` placeholders) and answers from a handler keyed
 * by a regex on the flattened SQL text. Enough for the store's insert/update/
 * returning shapes without a database.
 *
 * A fragment (`sql\`and id = ${id}\`` passed into another query, as
 * postgres.js allows) is inlined into the query that embeds it: its text in
 * place, its values numbered on from the outer ones, and it is not recorded
 * as a query of its own.
 */
export interface RecordedQuery {
  text: string;
  values: unknown[];
}

export type FakeSqlHandler = (q: RecordedQuery) => unknown[] | undefined;

interface Fragment {
  strings: TemplateStringsArray;
  values: unknown[];
  recorded: RecordedQuery;
}

export function fakeSql(handlers: [RegExp, FakeSqlHandler][] = []): postgres.Sql & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const fragments = new WeakMap<object, Fragment>();

  // Inline embedded fragments (dropping them from the recorded queries) and number the remaining values.
  const render = (strings: TemplateStringsArray, values: unknown[], out: unknown[]): string =>
    strings.reduce((acc, s, i) => {
      if (i >= values.length) return acc + s;
      const v = values[i];
      const frag = v !== null && typeof v === "object" ? fragments.get(v) : undefined;
      if (frag) {
        const at = queries.indexOf(frag.recorded);
        if (at >= 0) queries.splice(at, 1);
        return acc + s + render(frag.strings, frag.values, out);
      }
      out.push(v);
      return acc + s + `$${out.length}`;
    }, "");

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    // `sql(rows)` / `sql(rows, ...columns)`: the multi-row insert helper, embedded as one value (synchronously, as postgres.js does).
    if (!Array.isArray(strings) || !("raw" in strings)) return { __rows: strings, columns: values };
    const flat: unknown[] = [];
    const text = render(strings, values, flat).replace(/\s+/g, " ").trim();
    const q = { text, values: flat };
    queries.push(q);
    const pending = (async () => {
      for (const [re, h] of handlers) if (re.test(text)) return h(q) ?? [];
      return [];
    })();
    fragments.set(pending, { strings, values, recorded: q });
    return pending;
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
