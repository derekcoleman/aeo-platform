# Security one-pager

For the customer's security reviewer. Short on purpose; every claim here is
enforced by code or a test named below.

## What we run on your domain

Only the content prefix you rewrite to us (for example `/resources/*`). The
rest of your site never touches our systems. If we are down, only that prefix
is affected: your Worker serves stale content from its cache and, once the
mirror ships, from a static copy.

## Cookies and credentials never reach us

Because `/resources/*` is same-origin with your site, a browser sends your
session cookies with every request. Four layers drop them:

1. The Cloudflare Worker you install strips `Cookie`, `Authorization` and
   `Proxy-Authorization` before forwarding (`edge/customer-worker.template.js`).
2. Our middleware deletes the same headers before any handler runs
   (`middleware.ts`, `STRIPPED_REQUEST_HEADERS`).
3. No handler on the render path reads cookies; `scripts/verify-proxy.sh`
   asserts on every CI run that a cookie sent to a rendered page is absent
   from the response and that we never set a cookie on your domain.
4. Rendered pages ship zero client JavaScript (asserted by the same script).

Install modes without a Worker (Vercel rewrite, nginx, Netlify) cannot strip
at your edge; layers 2 to 4 still apply, and we say so in the Install tab.

## Tenant isolation

- Every row carries `org_id`; every tenant table has row-level security
  enabled and forced (`supabase/migrations/*`, asserted per table by
  `supabase/tests/isolation.sql` on every CI run).
- The public renderer connects as a database role that can read exactly two
  tables (`content.published_pages`, `content.site_render_config`) and nothing
  in the `app` schema. The isolation suite fails if that widens.
- The site being rendered is decided by the `Host` header (a dedicated,
  non-guessable hostname per site), never by user input. The tenant id is
  in the internal route path, so a cache bug cannot serve one customer's page
  under another's URL. Your Worker verifies `X-AEO-Site` on every response and
  fails open to your origin if it does not match.
- Nothing rendered may contain our edge hostname; a link-discipline assertion
  runs on every response in CI.

## Your data (Slack, calls, documents)

- Redaction runs before anything is chunked or embedded: secrets, card
  numbers, emails and phone numbers are replaced with fixed tokens
  (`lib/context/redact.ts`, tested).
- Connectors are explicit opt-in per channel or property; we never request
  workspace-wide history scopes.
- OAuth tokens are stored by reference (`secret_ref`), never in a tenant row.
- Retention: ingested documents and their chunks are purged nightly after the
  organisation's retention window (default 365 days, configurable 30 to
  3650). Verified facts you approved, your manifesto and published content
  are kept. Disconnecting a source deletes its documents.
- Model providers are used with zero-data-retention terms; no transcript is
  ever sent through an aggregator that cannot offer them.

## Telemetry

Crawler hits are recorded with a salted hash of the source address, never the
address itself. Telemetry posts from your Worker are signed with a per-site
secret and unsigned posts are rejected.

## Access and audit

- Staff access is a separate axis from customer membership, and every staff
  or owner action on your organisation writes to `app.audit_log` (viewable
  in the ops console).
- Membership roles: owner, admin, editor, viewer. Only owners manage billing
  and settings; an organisation always keeps at least one owner.

## Subprocessors

Supabase (database, auth), Vercel (application hosting), Cloudflare (edge),
Anthropic (models), Inngest (job orchestration), Resend (email), Stripe
(billing). SERP data providers (DataForSEO, SerpApi) receive only the
questions being tracked.
