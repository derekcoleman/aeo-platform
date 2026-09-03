/**
 * A `fetch` stand-in keyed by URL. A route is a response spec or a function of
 * the request (so a route can answer differently per user agent or header).
 * Every call is recorded with its URL, user agent and headers, so a test can
 * assert what was probed and how.
 */
export interface RouteSpec {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  userAgent: string | null;
  headers: Record<string, string>;
}

export type Route = RouteSpec | ((call: RecordedCall) => RouteSpec | undefined);

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  /** Calls to a URL (query string included) or to every URL starting with a prefix ending in `*`. */
  callsTo(pattern: string): RecordedCall[];
}

/** Routes match on the exact URL (query included), then on a trailing-`*` prefix; unmatched URLs 404. */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const calls: RecordedCall[] = [];
  const resolve = (url: string): Route | undefined => {
    if (routes[url]) return routes[url];
    const prefix = Object.keys(routes)
      .filter((k) => k.endsWith("*") && url.startsWith(k.slice(0, -1)))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? routes[prefix] : undefined;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers as HeadersInit | undefined);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const call: RecordedCall = { url, userAgent: h.get("user-agent"), headers };
    calls.push(call);
    const route = resolve(url);
    const spec = typeof route === "function" ? route(call) : route;
    if (!spec) return new Response("not found", { status: 404 });
    return new Response(spec.body ?? "", { status: spec.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...(spec.headers ?? {}) } });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    callsTo: (pattern) => (pattern.endsWith("*") ? calls.filter((c) => c.url.startsWith(pattern.slice(0, -1))) : calls.filter((c) => c.url === pattern)),
  };
}
