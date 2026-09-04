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

- `/ops/setup` shows **Edge wildcard DNS** as passing once
  `_aeo-probe.<AEO_EDGE_DOMAIN>` resolves.
- `curl -sI -H 'Host: <allocated hostname>' https://<AEO_EDGE_DOMAIN-wildcard-target>/`
  returns a 404 with `X-AEO-Passthrough: 1` for an unknown path prefix, or the
  article for a real one.
- A site's Install tab now shows a Worker whose `origin` is that hostname.

## What the customer installs

From the site's Install tab, per mode:

- **Cloudflare Worker (Mode A):** `aeo-proxy.worker.js` with the site id,
  edge hostname, the site's HMAC secret and our telemetry endpoint filled in.
  The Worker signs every proxied request (`x-aeo-sig` over host + path +
  minute) and every telemetry post (over the JSON body). We verify both.
- **Vercel rewrite / nginx / Netlify (Modes B and C):** a rewrite block. No
  signature and no edge telemetry; crawl coverage is reported as *partial*.
- **Subdomain (Mode D):** a CNAME. Strictly worse for AEO; tracked as a cohort.

## Telemetry endpoints

- `POST /api/ingest/crawl` — batched crawler hits from the Worker. Body-signed.
- `POST /api/ingest/alert` — Worker-observed failures (site mismatch, loop,
  origin error, mirror served). Body-signed.

Both require `APP_URL` so the Install tab can fill the endpoint in.
