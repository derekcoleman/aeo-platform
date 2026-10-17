# Edge domain setup

Every site gets a dedicated, non-guessable hostname under `AEO_EDGE_DOMAIN`
(for example `acme-resources-8f2a1c3d.blogedge.example.com`). The customer's
rewrite points at that hostname; nothing else ever references it, and no
rendered byte may contain it (`scripts/verify-proxy.sh` asserts this).

Allocated hostnames only work once the wildcard resolves to this app. Three
steps, done once per environment.

## 1. Pick the domain

Use a subdomain of a domain you own, e.g. `blogedge.example.com`. Set it in
Vercel as `AEO_EDGE_DOMAIN=blogedge.example.com` (Production and Preview) and
redeploy. Existing sites keep the hostname they were allocated, so choose this
before onboarding real customers.

## 2. Point the wildcard at Vercel

Vercel project → Settings → Domains → add `*.blogedge.example.com`. Vercel
issues a wildcard certificate; that requires the zone's nameservers to be
Vercel's, **or** the DNS records Vercel shows for wildcard verification.

DNS (at your DNS provider, or Cloudflare with the proxy cloud **off** for this
record):

```
*.blogedge.example.com.   CNAME   cname.vercel-dns.com.
```

If the zone is on Cloudflare and you want Cloudflare in front of Vercel
(host-scoped cache, crawl logging at the edge, R2 mirror), keep the record
proxied and add a Worker route for `*.blogedge.example.com/*` later. Start
with the DNS-only record: the customer's own Worker already provides the
per-site cache and telemetry.

## 3. Verify

- Settings → Deployment (`/settings?tab=deployment`) shows **Edge wildcard DNS** as passing once
  `_aeo-probe.<AEO_EDGE_DOMAIN>` resolves.
- `curl -sI -H 'Host: <allocated hostname>' https://<AEO_EDGE_DOMAIN-wildcard-target>/`
  returns a 404 with `X-AEO-Passthrough: 1` for an unknown path prefix, or the
  article for a real one.
- A site's Install tab now shows a Worker whose `origin` is that hostname.

## What the customer installs

From the site's Install tab, per mode:

- **Cloudflare Worker (Mode A):** `aeo-proxy.worker.js` with the site id,
  edge hostname, canonical domain, the site's HMAC secret and our telemetry
  endpoint filled in. The Worker signs every proxied request (`x-aeo-sig`
  over host + path + minute) and every telemetry post (over the JSON body).
  We verify both. Only owners and admins see the secret in the Install tab;
  other roles get a placeholder in its place.
- **Vercel rewrite / nginx / Netlify (Modes B and C):** a rewrite block. No
  signature and no edge telemetry; crawl coverage is reported as *partial*.
- **Subdomain (Mode D):** a CNAME. Strictly worse for AEO; tracked as a cohort.

## Worker versions and upgrading

The Install tab always generates the current Worker
(`CURRENT_WORKER_VERSION` in `lib/proxy/install.ts`, now `"2"`). Version 2
differs from version 1 in four ways:

- It deletes every `x-aeo-*` header a visitor sent before adding its own hop
  count, signature and version, so nobody can speak for the Worker or for our
  origin.
- It caches at the customer's edge for one hostname only (`CONFIG.cacheHost`,
  generated as the canonical domain). Cloudflare keys that cache on the URL
  the Worker fetches from us, which every host routed to the Worker shares,
  so caching on a second host could serve that host's page, canonical link
  included, on the first.
- It never caches a redirect (3xx) or an error (5xx). Version 1 cached a 3xx
  for 60 seconds on every host, overriding our cache headers.
- It reports its version: as the `x-aeo-worker-version` header on every
  request to our origin, and as `workerVersion` in every crawl report.

**How we know which version runs.** The crawl ingest route stamps
`app.sites.worker_version` and `worker_seen_at` from authenticated reports,
at most once a minute per site. A version 1 Worker reports nothing.

**The upgrade notice.** A project in Mode A that is installed and whose
Worker has reported no version, or an older one, gets a notice in the Install
tab asking for a redeploy (`workerUpgradeNotice`). The notice clears with the
first crawl report from a version 2 Worker.

**To upgrade a customer's Worker:**

1. Open the project's Install tab and copy the generated Worker. You need to
   be an owner or admin to get it with the signing secret filled in.
2. In the customer's Cloudflare dashboard, open the existing Worker, replace
   its script with the new one, and deploy. The route
   (`acme.com/resources/*`) stays as it is.
3. If the Worker is routed on a host other than the canonical domain (for
   example `www.acme.com`), set `cacheHost` in `CONFIG` to that host. Never
   list two hosts.
4. Verify:
   - `curl -sI https://acme.com/resources/<slug> -H 'X-AEO-Internal-Redirect: https://evil.example/'`
     returns 200 with no `Location` header.
   - The Install tab notice disappears after the next AI crawler hit.

Until a customer redeploys, our origin still strips forged internal headers,
so the redirect forgery is closed for version 1 too. Only version 2 stops
that customer's edge from caching our redirects for a minute.

## Telemetry endpoints

- `POST /api/ingest/crawl` — batched crawler hits from the Worker. Body-signed.
  Each batch carries the Worker's version.
- `POST /api/ingest/alert` — Worker-observed failures (site mismatch, loop,
  origin error, mirror served). Body-signed.

Both require `APP_URL` so the Install tab can fill the endpoint in.
