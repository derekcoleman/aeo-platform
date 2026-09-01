# aeo-platform

Agentic AEO/GEO growth for mid-market B2B SaaS. Measures AI-answer visibility,
finds the citation gap, generates content grounded in real company context,
publishes it on the customer's own domain via reverse proxy, then re-measures
and attributes the lift.

Strategy and architecture: `/root/.claude/plans/` (see the approved plan).

## Status — Phase 0

The foundation and the render/proxy vertical slice.

| | |
|---|---|
| ✅ | Tenancy model, RLS, least-privilege renderer role |
| ✅ | Host → site resolution and the proxy contract |
| ✅ | Zero-JS article renderer + AEO artifacts (sitemap, llms.txt, feed, `.md`) |
| ✅ | Install config generation for all four proxy modes |
| ⬜ | Ops console, publish pipeline, brand brain, audit port |

## Architecture in one diagram

```
acme.com/resources/*            customer's edge — they install one rewrite
   └─> acme-8fj2.blogedge…      our edge — cache, crawl logging, R2 fallback
        └─> middleware.ts       Host → site_id, cookie strip, loop guard
             └─> /render/{siteId}/…   tenant-in-path, so caches can't cross tenants
                  └─> content.published_pages   read by a role that sees one table
```

The rest of the customer's site is structurally untouched: only their content
prefix routes to us, and if we are unavailable that prefix serves stale cache or
a static mirror.

## Invariants

These are enforced in code and asserted in tests. Changing one is a design
decision, not a refactor.

1. **No rendered byte contains our edge hostname.** A leak in a canonical tag
   would tell search and answer engines that the canonical home of the
   customer's content is a third-party host. `assertNoEdgeHostname` is the
   backstop; `absoluteUrl` refuses to build one.
2. **An unverified `x-forwarded-host` renders `noindex`, never 404.** The
   failure mode is "not indexed", never "duplicate of the customer's content
   under a host they don't control".
3. **Cookies never reach a handler.** The blog is same-origin with the
   customer's site, so browsers attach their session cookies to every article
   request. Stripped in middleware; also stripped at their edge in Worker mode.
   We never set a cookie on their domain.
4. **The renderer reads two tables and nothing else.** No service role, no user
   JWT — there is no user on the public path.
5. **Article pages ship zero client JavaScript.** AI crawlers fetch raw HTML
   without executing JS, and the page must survive a strict CSP or a blocked
   CDN. This is why the article is a route handler, not a page component.
6. **JSON-LD is built from structured data, never written by a model.** Schema
   is a machine contract; invented properties validate as nothing.

## Development

```bash
npm install
cp .env.example .env.local     # fill in Supabase + edge settings
npm run dev
npm run check                  # typecheck + lint + unit tests
```

### Database

```bash
# apply migrations in order, then the isolation assertions, then fixtures
for f in supabase/migrations/*.sql; do psql -d "$DB" -v ON_ERROR_STOP=1 -f "$f"; done
psql -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/isolation.sql
psql -d "$DB" -v ON_ERROR_STOP=1 -f supabase/seed.sql
psql -d "$DB" -c "alter role renderer login password 'renderpw'"
```

`supabase/tests/isolation.sql` asserts, among other things, that a malformed
JWT claim denies rather than grants and that the renderer role cannot reach
`app.sites`. If one starts failing, fix the policy — don't adjust the
expectation.

### Verifying the proxy contract

Unit tests cover the decision logic; `scripts/verify-proxy.sh` covers the wire.
It asserts the invariants above against a running server — including that a
forged `x-forwarded-host` cannot move the canonical, that cookies never reach a
handler, and that no response contains our edge hostname.

```bash
node tests/fixtures/site-api.mjs 9999 &   # stands in for PostgREST site lookup
npm run build && npx next start -p 3401 &
./scripts/verify-proxy.sh http://localhost:3401
```

CI runs all three layers on every pull request (`.github/workflows/ci.yml`):
typecheck/lint/unit tests, migrations plus the isolation assertions against a
real Postgres, and the proxy contract against a live server.

### Reproducing the proxy locally

```bash
curl -H 'Host: acme-8fj2.blogedge.aeo.app' \
     -H 'X-Forwarded-Host: acme.com' \
     -H 'X-AEO-Hops: 1' \
     http://localhost:3000/resources/some-article
```

Omit `X-Forwarded-Host` and the response should be `noindex` — that is invariant
2 working, not a bug.
