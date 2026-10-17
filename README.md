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
| ✅ | Connectors page: every source listed connected or not; Google property and Slack channel setup; custom API / MCP sources (`docs/CONNECTORS.md`) |
| ✅ | Content refresh: Webflow inventory × Search Console × citations → ranked, updated in place (`docs/REFRESH.md`) |
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
handler, and that no response contains our edge hostname — and the takedown
contract: a retired page answers 410, a noindex page carries `X-Robots-Tag`
and an ETag of its own, and neither appears in the sitemap, feed or llms files.

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

### Taking content down

Every switch is read by the renderer on the next request (a CDN may keep its
copy for the 5-minute `s-maxage`), and every change is audited and reported
to the organisation's alerts channel and owners.

- **One page** (Content tab, editors): *Noindex* keeps serving it with a
  robots meta and `X-Robots-Tag`; *Retire* answers 410 Gone; *Restore* puts it
  back. Neither state is listed in the sitemap, feed or llms files. A page
  stays down until someone restores it: a version published meanwhile (a run
  already in flight, or one started to rewrite it) waits behind the takedown,
  and *Restore* serves that version. A different article published at the
  same path goes live, since the takedown was the old article's.
- **Roll back** republishes the version a page replaced, recomposed from
  storage with no model call, and puts a noindex page back live. A second
  rollback undoes the first. CMS posts roll back in the CMS.
- Restore and Roll back copy the page's version to the auto-push Webflow
  targets, as a publish does. Taking a page down does not remove its Webflow
  copy; unpublish that in Webflow.
- **A whole project** (Content tab, owners and admins): *Pause indexing*
  serves every page noindex, empties the listings, and holds publishing.
- **Kill switches** (`/ops`, staff): hold publishing and/or pause indexing for
  the platform, one organisation or one project (`ops.autonomy_controls`).
  A held publish step waits an hour and asks again, for up to three days,
  then the run fails and says why.

### Spend budgets

Every paid call goes through one governor (`lib/ops/spend.ts`, migration
0021): model calls (`llm`), SERP calls (`serp`) and AI-answer probes
(`answer_probe`).

- **Before the call** it holds the call's worst-case cost on every budget
  that covers it: the organisation's and, when one is set, the project's.
  A model call's worst case is the whole prompt plus every `max_tokens`
  token. One conditional update admits the call while spent plus held is
  under the cap, so two workers cannot both take the last dollar. The call
  admitted last may overshoot the cap by at most its own estimate. A refused
  call is never made and costs nothing.
- **After the call** the hold settles at the actual cost, or is released if
  the call failed. Holds older than 30 minutes belonged to a worker that
  died; a cron releases them every 15 minutes.
- **Monthly defaults** apply from an organisation's first spend: $200 for
  models and $25 for probes (`AEO_DEFAULT_*_MONTHLY_BUDGET_USD`). The SERP
  cap is the organisation's own setting. Staff change any cap in
  Ops → Spend. Periods are UTC months, or UTC days for a daily budget.
- **Alerts:** the organisation is told at 80% and at 100% of a budget, once
  each per period. At 100%, `ops/budget.exceeded` is also sent.
- **One article** (opportunity) may cost at most `AEO_ARTICLE_COST_CAP_USD`
  ($15) in model calls across all its attempts. The pipeline checks before
  each brief and draft. Past the cap, or when the organisation's model
  budget is spent, the run stops and hands the article to a human instead
  of retrying. The human's lever for one article is to ask for it again
  ("Write about this", or "Refresh now" for a refresh): reopening a
  stopped opportunity starts its count over. The env var moves the cap for
  every article.
