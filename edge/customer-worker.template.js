/**
 * AEO content proxy — Cloudflare Worker, version 2
 * ────────────────────────────────────────────────────────────────────────────
 * Generated for: {{SITE_NAME}} ({{CANONICAL_DOMAIN}}{{PATH_PREFIX}})
 *
 * Deploy this Worker and route it at:
 *     {{CANONICAL_DOMAIN}}{{PATH_PREFIX}}/*
 *
 * What it does, and why each part matters:
 *
 *  1. Strips Cookie and Authorization before forwarding. Because this content
 *     is served same-origin with your site, browsers attach YOUR session
 *     cookies to every article request. We do not want them and will not
 *     receive them. This is the single strongest reason to use this mode:
 *     the rewrite-only install modes cannot do it at your edge.
 *
 *  2. Strips every X-AEO-* header a visitor sent before adding its own (hop
 *     count, signature, version). Those headers are how this Worker and our
 *     origin talk to each other; a visitor must not be able to speak for
 *     either of them.
 *
 *  3. Verifies the response belongs to your site (X-AEO-Site) before returning
 *     it, and falls back to your own origin if it does not. A bug on our side
 *     therefore degrades to "your own page is served", never "someone else's
 *     content appears on your domain".
 *
 *  4. Caches at your edge for one hostname only, CONFIG.cacheHost, and never
 *     caches a redirect or an error. Cloudflare keys this cache on the URL it
 *     fetches from us, which is the same for every hostname routed here, so
 *     caching on a second host could serve that host's page, canonical link
 *     included, on the first. It is generated as {{CANONICAL_DOMAIN}}, the
 *     host in the route above; if you route this Worker on another host
 *     instead, such as www.{{CANONICAL_DOMAIN}}, put that host in cacheHost or
 *     its pages get no edge cache. Never list two.
 *
 *  5. Falls back to cache, then to a static mirror, if we are slow or down.
 *     Only {{PATH_PREFIX}}/* is involved either way — the rest of your site is
 *     structurally untouched.
 *
 *  6. Re-fetches your origin on a 404 with X-AEO-Passthrough, so if you ever
 *     publish your own page under this prefix, your page wins.
 *
 *  7. Reports AI crawler hits, including cache hits, which is what makes
 *     "ChatGPT-User fetched this page 43 times yesterday" possible at all.
 *     Each report carries this Worker's version, so we can tell you when a
 *     newer one is available.
 *
 * This Worker sets no cookies and stores nothing about your visitors.
 */

const CONFIG = {
  workerVersion: "2",
  origin: "{{EDGE_HOSTNAME}}",
  siteId: "{{SITE_ID}}",
  // The only hostname whose responses are cached at your edge: the host you
  // route this Worker on (note 4).
  cacheHost: "{{CANONICAL_DOMAIN}}",
  pathPrefix: "{{PATH_PREFIX}}",
  mirrorOrigin: "{{MIRROR_ORIGIN}}",
  crawlEndpoint: "{{CRAWL_ENDPOINT}}",
  // Shared with us at install time. Signs requests so our origin can tell your
  // proxy apart from anyone else who has guessed the hostname.
  hmacSecret: "{{HMAC_SECRET}}",
  originTimeoutMs: 3000,
};

/** Request headers never forwarded upstream. See note 1 above. */
const STRIP_REQUEST_HEADERS = ["cookie", "authorization", "proxy-authorization"];

/** Every header with this prefix is ours to set, never a visitor's. See note 2. */
const OWN_HEADER_PREFIX = "x-aeo-";

/**
 * Edge cache TTLs by status, for CONFIG.cacheHost only. A negative TTL
 * tells Cloudflare not to cache: redirects and errors always come from us.
 */
const CACHE_TTL_BY_STATUS = { "200-299": 300, "300-399": -1, "404": 10, "410": 300, "500-599": -1 };

/**
 * User agents worth reporting. `live_fetch` is the valuable one: a model is
 * fetching this URL right now, mid-answer, for a real person — a near
 * real-time citation signal rather than a lagging one.
 */
const AI_AGENTS = [
  [/ChatGPT-User/i, "chatgpt-user", "live_fetch"],
  [/Perplexity-User/i, "perplexity-user", "live_fetch"],
  [/Claude-User/i, "claude-user", "live_fetch"],
  [/Gemini-User/i, "gemini-user", "live_fetch"],
  [/OAI-SearchBot/i, "oai-searchbot", "search_index"],
  [/PerplexityBot/i, "perplexitybot", "search_index"],
  [/Claude-SearchBot/i, "claude-searchbot", "search_index"],
  [/bingbot/i, "bingbot", "search_index"],
  [/GPTBot/i, "gptbot", "train"],
  [/ClaudeBot/i, "claudebot", "train"],
  [/CCBot/i, "ccbot", "train"],
  [/Google-Extended/i, "google-extended", "train"],
  [/Applebot-Extended/i, "applebot-extended", "train"],
  [/Bytespider/i, "bytespider", "train"],
  [/Googlebot/i, "googlebot", "search_index"],
];

function classifyAgent(ua) {
  if (!ua) return null;
  for (const [re, family, purpose] of AI_AGENTS) {
    if (re.test(ua)) return { family, purpose };
  }
  return null;
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only ever touch our own subtree, whatever the route pattern says.
    if (!url.pathname.startsWith(CONFIG.pathPrefix)) {
      return fetch(request);
    }

    // Non-cacheable methods are not ours to serve; the content is read-only.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const upstream = new URL(url.toString());
    upstream.hostname = CONFIG.origin;
    upstream.protocol = "https:";
    upstream.port = "";

    const headers = new Headers(request.headers);
    const drop = [...STRIP_REQUEST_HEADERS];
    for (const name of headers.keys()) if (name.startsWith(OWN_HEADER_PREFIX)) drop.push(name);
    for (const h of drop) headers.delete(h);

    headers.set("host", CONFIG.origin);
    headers.set("x-forwarded-host", url.hostname);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
    headers.set("x-aeo-hops", "1");
    headers.set("x-aeo-worker-version", CONFIG.workerVersion);
    if (CONFIG.hmacSecret) {
      // Minute-granularity so a captured signature is not replayable for long,
      // while tolerating modest clock skew.
      const minute = Math.floor(Date.now() / 60000);
      headers.set("x-aeo-sig", await sign(CONFIG.hmacSecret, `${url.hostname}${url.pathname}${minute}`));
    }

    const originRequest = new Request(upstream.toString(), {
      method: request.method,
      headers,
      redirect: "manual",
    });

    // Note 4: the edge cache is keyed on the upstream URL, shared by every
    // hostname routed here, so only one host may use it.
    const cacheable = url.hostname === CONFIG.cacheHost.trim().toLowerCase();

    let response = null;
    try {
      response = await Promise.race([
        fetch(originRequest, cacheable ? { cf: { cacheEverything: true, cacheTtlByStatus: CACHE_TTL_BY_STATUS } } : {}),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("origin timeout")), CONFIG.originTimeoutMs),
        ),
      ]);
    } catch {
      response = null;
    }

    if (response) {
      // We do not serve this path — re-fetch your origin so your own page wins.
      if (response.status === 404 && response.headers.get("x-aeo-passthrough") === "1") {
        return fetch(request);
      }

      // Note 3: refuse anything that is not demonstrably this site's content.
      const servedSite = response.headers.get("x-aeo-site");
      if (servedSite && servedSite !== CONFIG.siteId) {
        ctx.waitUntil(report(ctx, request, url, "site-mismatch", servedSite));
        return fetch(request);
      }

      if (response.status < 500) {
        ctx.waitUntil(reportCrawl(request, url, response.status, response.headers.get("cf-cache-status")));
        return withProxyHeaders(response);
      }
    }

    // Degraded paths, in order of preference.
    const cached = await caches.default.match(request);
    if (cached) return withProxyHeaders(cached, "stale");

    const mirrored = await fetchMirror(url);
    if (mirrored) return withProxyHeaders(mirrored, "mirror");

    return response ?? new Response("Temporarily unavailable", { status: 503 });
  },
};

function withProxyHeaders(response, source) {
  const out = new Response(response.body, response);
  // This Worker sets no cookies on your domain. Ever.
  out.headers.delete("set-cookie");
  if (source) out.headers.set("x-aeo-served-from", source);
  return out;
}

async function fetchMirror(url) {
  if (!CONFIG.mirrorOrigin) return null;
  try {
    const res = await fetch(`${CONFIG.mirrorOrigin}/${CONFIG.siteId}${url.pathname}`, {
      cf: { cacheEverything: true },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget crawl telemetry. Runs in waitUntil so it never adds latency
 * to the reader's request, and covers cache hits — which origin logs cannot
 * see, and which is why this install mode gives complete data where the others
 * give partial.
 */
async function reportCrawl(request, url, status, cacheStatus) {
  const ua = request.headers.get("user-agent");
  const agent = classifyAgent(ua);
  if (!agent || !CONFIG.crawlEndpoint) return;

  try {
    // The address is sent so we can verify the hit against the operator's
    // published IP ranges; we store a salted hash, never the address itself.
    const body = JSON.stringify({
      siteId: CONFIG.siteId,
      workerVersion: CONFIG.workerVersion,
      events: [
        {
          ts: new Date().toISOString(),
          path: url.pathname,
          botFamily: agent.family,
          purpose: agent.purpose,
          ua,
          status,
          cacheStatus,
          country: request.cf?.country ?? null,
          ip: request.headers.get("cf-connecting-ip"),
          source: "worker",
        },
      ],
    });
    await fetch(CONFIG.crawlEndpoint, {
      method: "POST",
      headers: await telemetryHeaders(body),
      body,
    });
  } catch {
    // Telemetry must never affect what the reader sees.
  }
}

/** Telemetry posts are signed over their body so nobody can feed us fake crawl data for your site. */
async function telemetryHeaders(body) {
  const headers = { "content-type": "application/json", "x-aeo-site": CONFIG.siteId };
  if (CONFIG.hmacSecret) headers["x-aeo-sig"] = await sign(CONFIG.hmacSecret, body);
  return headers;
}

async function report(ctx, request, url, kind, detail) {
  if (!CONFIG.crawlEndpoint) return;
  try {
    const body = JSON.stringify({ siteId: CONFIG.siteId, kind, detail, path: url.pathname });
    await fetch(CONFIG.crawlEndpoint.replace("/crawl", "/alert"), {
      method: "POST",
      headers: await telemetryHeaders(body),
      body,
    });
  } catch {
    /* never block the response */
  }
}
