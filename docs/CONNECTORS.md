# Connectors: Profound API and Webflow

Both are configured per project from the app; tokens go to Vault and the
connection row keeps only a reference.

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

**Endpoints:** the client defaults to `https://api.tryprofound.com/v1` with
`/categories` and `POST /reports/answers`. Both the base URL and the endpoint
paths are stored on the connection (`config.baseUrl`, `config.endpoints`) so
an ops person can adapt to an API change without a deploy. The connect step
calls the categories endpoint and shows exactly what came back, so a wrong
path fails loudly at connect time, not silently at 05:00.

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

**API:** Webflow Data API v2 (`/v2/sites`, `/v2/sites/{id}/collections`,
`/v2/collections/{id}`, `/v2/collections/{id}/items`, `/items/{id}`,
`/items/publish`). Rate limit 60/min; a 429 is retried once after the
requested delay. Set `WEBFLOW_API_BASE` only to point at a test double.
