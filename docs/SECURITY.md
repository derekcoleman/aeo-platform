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

## Headers a visitor cannot forge

Middleware tells the render handler what it decided (indexable or not, the
canonical host, a trailing-slash redirect) in `x-aeo-internal-*` request
headers.

- Middleware deletes every incoming `x-aeo-internal-*` header before setting
  its own (`renderRequestHeaders`, `lib/tenancy/proxy-policy.ts`), so a
  visitor cannot make a page indexable, move its canonical or set a redirect.
  The handler also refuses any redirect target that is not root-relative.
- `/render/*` is answered only on edge hostnames. On any other host it is a
  404, however the path is spelled: percent-encoded, doubled slashes or
  upper case.
- A response that may not be indexed is `private, no-store`, so no shared
  cache keeps it. Every render response carries `Vary: X-Forwarded-Host`.
- `scripts/verify-proxy.sh` asserts each of these on every CI run: a forged
  redirect header sets no `Location`, a forged indexable or canonical header
  changes nothing, and `/render` on the app host is a 404.

## Your Worker (version 2)

The Worker you deploy deletes every `x-aeo-*` header a visitor sent before
adding its own hop count, signature and version. It caches at your edge for
one hostname only, and never caches a redirect or an error. Version 1 cached
a 3xx for a minute on every host routed to it. The header strip above closes
the forgery for version 1 as well, but only version 2 stops your edge from
caching our redirects. The Worker reports its version, and the Install tab
asks a project still on version 1 to redeploy (`docs/EDGE_SETUP.md`).

## Outbound requests

Every server-side fetch of a URL that a customer or a model supplied
(website crawl, custom API or MCP source, cited sources checked by QA) goes
through `safeFetch` (`lib/fetch`). It refuses private, loopback, link-local
and other special addresses in IPv4 and in every IPv6 spelling: mapped,
compatible, NAT64, 6to4 and Teredo addresses are judged by the IPv4 address
they carry, and an address that does not parse is refused. Every redirect hop
is re-checked, and responses are size-capped (2 MB for QA's source checks).
One known gap remains: a DNS answer can change between the check and the
connection. Pinning the connection to the checked address is on the roadmap.

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
- Connecting a source (Google and other OAuth connectors) checks that the
  project belongs to the organisation starting the flow
  (`assertSiteInOrg`). A database trigger refuses a connection bound to
  another organisation's project for every writer, members writing through
  row-level security included.
- Actions that take a topic or question id check that it belongs to the
  project being edited, even on the service connection that bypasses
  row-level security.

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
secret and unsigned posts are rejected. A bot seen at our origin is verified
against the address our hosting platform reports (`trustedClientIp`:
`x-vercel-forwarded-for`, then `x-real-ip`), never against a header a client
could set, such as `cf-connecting-ip` or `x-forwarded-for`.

## Webhooks

Stripe and Slack deliveries are claimed in a ledger (`ops.webhook_events`)
before they are processed. If processing fails, the claim is released with the
error and we answer 500, so the provider's retry delivers the event again
rather than it being taken for a duplicate. A re-drive job every 15 minutes
delivers anything older than ten minutes and younger than three days, up to
five attempts. A repeat of an event already processed does nothing.

## Access and audit

- Staff access is a separate axis from customer membership, and every staff
  or owner action on your organisation writes to `app.audit_log` (viewable
  in the ops console).
- Membership roles: owner, admin, editor, viewer. Only owners manage billing
  and settings; an organisation always keeps at least one owner.
- The Worker's signing secret is shown in the Install tab to owners and
  admins only; other roles see a placeholder. Database column privileges on
  the secret are on the roadmap: today a member can still read it through the
  API, under row-level security.
- A Slack approval counts only for the organisation that installed that
  workspace. Mapping individual Slack members to project roles is on the
  roadmap.
- Any page can be taken down from the Content tab (noindex, or retire with a
  410), a project can pause indexing, and staff hold kill switches for a
  project, an organisation or the platform. Each change is audited.

## Subprocessors

Supabase (database, auth), Vercel (application hosting), Cloudflare (edge),
Anthropic (models), OpenRouter (model routing when configured, and AI answer
probes), Inngest (job orchestration), Resend (email), Stripe (billing). An
answer probe sends OpenRouter one tracked prompt and nothing else: no
documents, facts or other customer data. SERP data providers (DataForSEO,
SerpApi) receive only the questions being tracked and, for the competitor
gap, the domains being compared.
