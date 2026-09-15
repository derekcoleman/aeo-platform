# Connectors

Tokens go to Vault; the connection row keeps only a reference. Every sync
writes a `context.context_sync_runs` row, so a failing connector is a red
row, never silence.

## The Connectors page

Project → **Connectors** (`/app/sites/{id}/connectors`) lists **every**
connector the product offers for that project, connected or not, as a
compact grid of tiles in three groups. A tile opens a dialog with what the
connector feeds, the rows that exist and their sync state, and the connect or
setup form. `/settings/connectors` redirects to the user's first project and
carries the query an OAuth callback attaches.

| Group | Connectors | Scope |
|---|---|---|
| Measure | Google Search Console, Google Analytics 4, Profound | per project |
| Publish | Webflow | per project |
| Brand brain sources | Your website, Slack, Custom source (API or MCP) | website per project; Slack and custom for the organisation (a custom source can also be pinned to one project) |

Organisation-wide rows (Slack, org-level custom sources) show on every
project's page; project-scoped rows only on their own. The catalogue is
`lib/connectors/catalog.ts`; the read model that joins it with the org's rows
and the option lists is `lib/app/connectors.ts`.

States: **connected**, **needs setup** (a token exists and nothing is being
read: a Google grant with no property chosen, a Slack install with no
channels), **error** (the last sync failed; the reason is on the card),
**not connected**.

**Google** is one OAuth grant per project that serves two cards: Search
Console (pick the property) and GA4 (pick the property). Until a property is
chosen the grant is *pending* and the sync is a no-op. The OAuth client comes
from `GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI`; the card says
so when they are missing.

**Slack** is one install per organisation. The card lists the channels the
app can see; nothing is read until channels are ticked. The same form sets
the approvals channel (brief/draft decisions with buttons) and the alerts
channel (proxy health). Private channels need the app invited first.

**Your website** is created with the project; the card shows the crawl and
recreates it if it was disconnected.

## Profound (Enterprise API)

**Where:** project → Strategy → Visibility → *Connect Profound*.

**What it does:** every night (and on connect, a 90-day backfill) the
connection pulls the answers report for the chosen category and normalises
it into the same shape the CSV upload uses: prompts become tracked questions
(source `profound`), each prompt × platform × day becomes a snapshot with its
citations (`provider = 'profound'`, `is_owned` computed against your domains),
and the visibility score lands in `measure.external_metrics` (surface
`profound_visibility`). Native metrics never read Profound rows; the UI labels
Profound numbers as Profound's.

**Refresh:** Profound citations of a CMS URL feed the refresh score
(`docs/REFRESH.md`) alongside the native trackers, and are labelled as
Profound's on the Refresh page.

**Endpoints:** the client follows Profound's official TypeScript SDK
(`@profoundai/client`): base `https://api.tryprofound.com`, the API key in
the `X-API-Key` header, `GET /v1/org/categories` for the category list (one
row per category × organisation), and `POST /v1/prompts/answers` for the
answers report (one row per prompt × model × run, `pagination: {limit,
offset}`, date-time bounds, `include` selecting fields; the answer text is
never requested). A brand mention is `asset ∈ mentions`. Both the base URL
and the endpoint paths are stored on the connection (`config.baseUrl`,
`config.endpoints`) so an ops person can follow a rename without a deploy,
and a versioned base plus a versioned path never doubles the segment.

The connect step discovers the category list rather than trusting the
default: it tries the configured path, then `/v1/categories`, `/categories`,
`/v1/orgs` and `/v1/organizations`, on the configured base and on the base
with a trailing version segment removed. A 401/403 stops the search (the path
exists, the key is wrong); a 404 (`{"detail":"Not Found"}`) moves on. Whatever
answered is written to the connection. When nothing answers and a category id
was entered, one row of the answers report proves the key and category
instead, and the connection is created with that id. The form's *Advanced*
section takes exact paths for the case where both have moved. The error names
every URL tried and its status.

**Field names:** the normaliser accepts the spellings Profound has used
(`prompt` / `prompt_text`, `platform` / `engine` / `model`, `date` / `day`,
`brand_mentioned` / `mentioned`, `visibility` / `share_of_voice`,
`citations` / `sources`). Rows without a prompt or a date are counted as
dropped in the sync run's detail.

**Feature flag:** the connector sits behind the `connector:profound` org
feature; connecting from the app enables it. Disable it in `/ops` to prove
the product computes every metric without Profound.

## Webflow (publishing)

**Where:** project → Publishing.

1. Paste a **site API token** (Webflow site settings → Apps & integrations →
   API access) with `cms:read` and `cms:write`. The app lists the sites the
   token can see.
2. Choose the site and the **collection** that holds blog posts. The app
   reads the collection's fields and suggests a field map: title, slug, rich
   text body, summary, main image, published date, canonical URL, author.
   Every slot can be changed.
3. **Test** creates a draft item and deletes it again, proving the token,
   the collection and the map.
4. With *auto push* on, every article the pipeline publishes is created in
   the collection (and published live, unless you keep it staged). Re-publishing
   an article updates the same item; nothing is duplicated.

**Canonical:** when the proxy also serves the article, keep *Proxy copy is
canonical* and map a canonical field, so search engines and AI crawlers are
told which copy is the original. If Webflow is the only destination, pick
*Webflow copy is canonical*.

**Status:** Publishing shows every push per target with the Webflow item id,
the last error if any, and a re-push button. Failures never affect the
pipeline's own run; they are rows you can act on.

**Inventory:** the connection's daily sync (and *Sync inventory now* on the
Refresh page) lists every item of every collection the token can see into
`content.cms_items` — collection, last modified, last published, body — so
existing posts can be scored for a refresh against Search Console and AI
citations and updated in place. See `docs/REFRESH.md`.

**Where else:** the project's Connectors page, Webflow tile.

**API:** Webflow Data API v2 (`/v2/sites`, `/v2/sites/{id}/collections`,
`/v2/collections/{id}`, `/v2/collections/{id}/items` (list + create),
`/items/{id}`, `/items/publish`). Rate limit 60/min; a 429 is retried once
after the requested delay. Set `WEBFLOW_API_BASE` only to point at a test
double.

## Sync status and errors

Every run is a `context.context_sync_runs` row. The Visibility card reads the
latest row plus `context_connections.sync_requested_at` (set when a manager
queues a sync and the event is accepted) and reports one of: queued, running,
lost (accepted, grace period passed, nothing ran: the job runner is not
receiving events or the app is not synced), stalled (a run "running" past 20
minutes was killed by the function limit), failed (with the recorded error), or
succeeded (rows, metrics, window). Killed runs are closed as failed by the next
run of the same connection.

A Profound API backfill is walked in 30-day windows: each window is its own
run and cursor, and the job queues the next window from `detail.next.from`, so
no single invocation outlives Vercel's 300-second limit.

## Custom source (API or MCP)

**Where:** the project's Connectors page, Custom source tile. Owners and
admins only. "Applies to" chooses this project or the whole organisation.

A source the customer defines instead of one we ship. Both kinds land in
`context.context_documents` exactly like Slack messages and the website
crawl, so redaction, chunking, fact extraction and retrieval see them with
no extra plumbing. Provider `custom`; adapter `lib/connectors/custom`.

**HTTP API.** A URL that returns either a JSON list of records or a page of
text (Markdown, HTML, plain text). Records are found at the configured
*items path* or under a common key (`items`, `data`, `results`, …); each
record becomes a document through a small field map (id, title, text,
updated-at) whose blanks fall back to common names (`id`/`url`/`slug`,
`title`/`name`, `text`/`content`/`body`/`markdown`/`description`, …). HTML
text is converted to Markdown. A non-JSON response becomes one document.

**MCP server.** A Model Context Protocol endpoint over Streamable HTTP. The
connector runs `initialize` (protocol `2025-06-18`, honouring
`Mcp-Session-Id`), then `resources/list` (paged) and `resources/read` for
every resource, optionally only those whose URI starts with a prefix. Text
contents become documents; binary blobs are skipped. Responses may be JSON
or SSE; both are parsed.

**Auth.** None, a bearer token, or an API key in a named header. The secret
goes to Vault; config holds the URL, the kind and the mapping only.

**Safety.** Every request goes through `safeFetch`: URLs that resolve to
private networks, link-local or loopback addresses are refused, responses
are capped at 8 MB, and *Test and connect* performs a real probe (the
endpoint must yield at least one document, or the server at least one
matching resource) before anything is saved. Documents are capped at 60k
characters and 500 records / resources per sync.
