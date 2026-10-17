import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInstall } from "@/lib/proxy/install";

/**
 * The generated Cloudflare Worker, run for real: substituted exactly as the
 * Install tab hands it out, loaded as a module, with `fetch` and the edge
 * cache stubbed. What it forwards to us and how it asks Cloudflare to cache
 * are the parts a customer cannot see and we cannot patch after deploy.
 */

const SITE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const EDGE = "acme-8fj2.blogedge.aeo.app";
const CRAWL = "https://api.aeo.app/api/ingest/crawl";

interface Upstream {
  url: string;
  headers: Headers;
  cf: Record<string, unknown> | undefined;
  body: string | null;
}

type WorkerModule = { default: { fetch(req: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> } };

/** `edit` stands in for a customer changing the generated CONFIG before deploying. */
async function loadWorker(edit: (config: string) => string = (c) => c): Promise<WorkerModule> {
  const { config } = buildInstall({
    site: { id: SITE_ID, name: "Acme", canonicalDomain: "acme.com", pathPrefix: "/resources", edgeHostname: EDGE, proxyMode: "cloudflare_worker" },
    hmacSecret: "s3cret",
    crawlEndpoint: CRAWL,
  });
  return (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(edit(config)).toString("base64")}`)) as WorkerModule;
}

/** Stubs the Worker's globals; `respond` answers each upstream fetch. */
function stubEdge(respond: (u: Upstream) => Response = () => new Response("<p>ok</p>", { status: 200, headers: { "x-aeo-site": SITE_ID } })) {
  const calls: Upstream[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit & { cf?: Record<string, unknown> }) => {
    const req = typeof input === "string" ? new Request(input, init) : input;
    const call = { url: req.url, headers: req.headers, cf: init?.cf, body: typeof init?.body === "string" ? init.body : null };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal("caches", { default: { match: async () => undefined } });
  const pending: Promise<unknown>[] = [];
  return { calls, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("customer Worker v2", () => {
  it("strips every x-aeo-* header a visitor sent and sets its own", async () => {
    const worker = await loadWorker();
    const edge = stubEdge();
    const res = await worker.default.fetch(
      new Request("https://acme.com/resources/hello", {
        headers: {
          "x-aeo-internal-redirect": "https://evil.example/",
          "X-AEO-Internal-Indexable": "1",
          "x-aeo-hops": "0",
          "x-aeo-sig": "forged",
          "x-aeo-worker-version": "99",
          cookie: "session=secret",
          authorization: "Bearer x",
          "user-agent": "Mozilla/5.0",
        },
      }),
      {},
      edge.ctx,
    );
    expect(res.status).toBe(200);
    const up = edge.calls[0]!;
    expect(up.url).toBe(`https://${EDGE}/resources/hello`);
    const names = [...up.headers.keys()];
    expect(names.filter((n) => n.startsWith("x-aeo-internal-"))).toEqual([]);
    expect(up.headers.get("cookie")).toBeNull();
    expect(up.headers.get("authorization")).toBeNull();
    expect(up.headers.get("x-aeo-hops")).toBe("1");
    expect(up.headers.get("x-aeo-worker-version")).toBe("2");
    expect(up.headers.get("x-aeo-sig")).toMatch(/^[0-9a-f]{64}$/);
    expect(up.headers.get("x-forwarded-host")).toBe("acme.com");
    expect(up.headers.get("user-agent")).toBe("Mozilla/5.0");
  });

  it("uses the edge cache on the canonical host, and never for a redirect or an error", async () => {
    const worker = await loadWorker();
    const edge = stubEdge();
    await worker.default.fetch(new Request("https://acme.com/resources/hello"), {}, edge.ctx);
    const cf = edge.calls[0]!.cf as { cacheEverything: boolean; cacheTtlByStatus: Record<string, number> };
    expect(cf.cacheEverything).toBe(true);
    expect(cf.cacheTtlByStatus["200-299"]).toBe(300);
    // Negative: Cloudflare does not cache at all.
    expect(cf.cacheTtlByStatus["300-399"]).toBeLessThan(0);
    expect(cf.cacheTtlByStatus["500-599"]).toBeLessThan(0);
    expect(Object.keys(cf.cacheTtlByStatus)).not.toContain("301-399");
  });

  it("bypasses the edge cache on any other host routed to it", async () => {
    // The cache key is the upstream URL, the same for every host: an alias
    // host's (possibly noindex) answer must not be served on the canonical one.
    const worker = await loadWorker();
    const edge = stubEdge();
    await worker.default.fetch(new Request("https://www.acme.com/resources/hello"), {}, edge.ctx);
    expect(edge.calls[0]!.cf).toBeUndefined();
    expect(edge.calls[0]!.headers.get("x-forwarded-host")).toBe("www.acme.com");
  });

  it("caches on www instead when the customer routes it there and names it in cacheHost", async () => {
    // A site served from www gets its edge cache back, and the one-host rule
    // holds: the apex now bypasses it.
    const worker = await loadWorker((c) => c.replace('cacheHost: "acme.com"', 'cacheHost: "www.acme.com"'));
    const edge = stubEdge();
    await worker.default.fetch(new Request("https://www.acme.com/resources/hello"), {}, edge.ctx);
    await worker.default.fetch(new Request("https://acme.com/resources/hello"), {}, edge.ctx);
    expect(edge.calls[0]!.cf).toMatchObject({ cacheEverything: true });
    expect(edge.calls[1]!.cf).toBeUndefined();
  });

  it("passes our redirect through untouched", async () => {
    const worker = await loadWorker();
    const edge = stubEdge(() => new Response(null, { status: 301, headers: { location: "/resources/hello", "x-aeo-site": SITE_ID } }));
    const res = await worker.default.fetch(new Request("https://acme.com/resources/hello/"), {}, edge.ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/resources/hello");
  });

  it("reports its version with crawl telemetry", async () => {
    const worker = await loadWorker();
    const edge = stubEdge((u) => (u.url === CRAWL ? new Response(null, { status: 202 }) : new Response("<p>ok</p>", { headers: { "x-aeo-site": SITE_ID } })));
    await worker.default.fetch(new Request("https://acme.com/resources/hello", { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" } }), {}, edge.ctx);
    await edge.settle();
    const post = edge.calls.find((c) => c.url === CRAWL)!;
    expect(JSON.parse(post.body!)).toMatchObject({ siteId: SITE_ID, workerVersion: "2", events: [{ botFamily: "gptbot", source: "worker" }] });
    expect(post.headers.get("x-aeo-sig")).toMatch(/^[0-9a-f]{64}$/);
  });
});
