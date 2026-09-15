# Content refresh

New articles are half the job. The other half is the content a customer
already has: a Webflow blog with a few hundred posts, some of which used to
earn traffic and citations and no longer do. The refresh loop finds those,
ranks them, and runs them through the same pipeline — brief → draft → QA →
approval — before updating the post **in place**, same item, same URL.

## What it reads

| Signal | Source | Table |
|---|---|---|
| Which collection each item lives in, when it was last modified and last published, its body | Webflow Data API v2, every collection the site token can see | `content.cms_items` |
| Clicks, impressions, position per page, current 28 days vs the previous 28 | Search Console, site-wide (not filtered to the proxy prefix) | `measure.external_metrics`, surface `gsc_page_window` |
| How often the URL was cited in AI answers, last 30 days vs the 30 before | Our SERP trackers (`dataforseo`, `serpapi`) and, labelled separately, Profound | `measure.serp_citations` joined on `content.url_key(url)` |

The three meet on one key: `content.url_key()` in SQL and `urlKey()` in
`lib/refresh/inventory.ts` both reduce a URL to `host/path` without scheme,
`www.`, query, fragment or trailing slash, so `https://www.acme.com/blog/x/`
in GSC and `https://acme.com/blog/x` in a citation are the same page.

## The inventory

The Webflow connection's daily sync (05:00 UTC, and on demand from
Refresh → *Sync inventory now*) walks every site the token can see, every
collection, every item (`GET /collections/{id}/items`, 100 per page, up to
5,000 per collection). For each collection the field map is suggested the
same way the publish-target editor does it, so the body the scan reads is
the body a refresh writes back. Items are upserted on
`(connection, collection, external id)`; one that disappears from the CMS is
flagged `missing_since`, never deleted. Items we pushed ourselves are linked
to their `content_items` row through the `external_publications` ledger.

Collections without a rich-text field (authors, categories) are inventoried
but never candidates.

## The score

`lib/refresh/score.ts` is pure; the breakdown is stored next to the score
(`refresh_breakdown`, `refresh_signals`, `refresh_reasons` on the row) so a
number can be argued with.

| Factor | Weight | 0 → 100 |
|---|---|---|
| staleness | 25% | fresh → not modified in a year (unknown date counts as a year) |
| demand | 25% | log scale on 28-day impressions: 100 ≈ 50, 10k ≈ 100; neutral 50 without GSC |
| decline | 20% | clicks (base ≥ 10) or impressions (base ≥ 100) down vs the previous window; a 50% drop is the ceiling |
| citation gap | 20% | 90 lost every citation · 80 demand but never cited · 70 fewer citations · 40 uncited without demand · 0 cited and holding · 50 with no tracker data |
| thinness | 10% | 80 under 400 words · 40 under 800 |

Missing data is neutral, never zero: a site without Search Console gets 50
on demand and 0 on decline, and the Refresh page says so. Profound
citations count when the native trackers have nothing for the URL, and are
always shown as Profound's.

Never a candidate: drafts, archived items, items deleted in the CMS, items
without a body, anything modified in the last 45 days (engines have not
caught up), and anything with a refresh already queued or running.

## The queue

The nightly scan (09:30 UTC, after the connectors and the SERP trackers;
also right after every Webflow inventory sync) scores every item and opens a
`refresh` opportunity for the top 20 over the threshold (45). The dedupe key
is `cms:<item>:<last modified date>`: a refresh that lands, or an edit the
customer makes in Webflow, changes the key, so the item can be queued again
later; a dismissed entry stays dismissed until the post changes. *Refresh
now* on the page opens the opportunity whatever its score.

## The pipeline

A refresh opportunity carries `evidence.cmsItemId`. When the pipeline reaches
the content-item step it imports the post once as a **cms-origin** content
item (`content_items.origin = 'cms'`; the slug is internal and the post keeps
its own). The brief prompt gets the current article as Markdown, why it was
picked and the refresh rules (same head question and URL, keep what works,
replace or drop unsourced figures); the first draft attempt is written as a
revision of the live article rather than from a blank page. QA and the
approval policy apply unchanged.

Publishing a cms-origin item never touches `content.published_pages` — the
CMS URL is its home and a second copy under the proxy prefix would be a
duplicate. Instead `publishRefreshToCms` PATCHes title, body (with the FAQ
appended) and summary onto the same Webflow item, publishes it if it was
live (a staged post stays staged), and records the version on the item and
in `external_publications` when the collection is also a publish target.
`pushItemToTarget` refuses cms-origin items outright, so the auto-push after
`content/published` cannot create a duplicate post.

Refreshes of our own proxy-served articles (opened by the post-publish
+14/+30/+60 day loop) follow the same path with the current version as the
existing content, and publish through the proxy as before.

## Where to look

- Refresh page: `/app/sites/{siteId}/refresh` — *Needs a refresh* (ranked,
  with the reasons and the signals each number came from) and *All CMS
  content* (the inventory with state, dates, traffic, citations).
- `lib/refresh/inventory.ts` mapping + persistence, `lib/refresh/scan.ts`
  signals + scoring + opportunities, `lib/refresh/publish.ts` import + the
  in-place publish, `lib/inngest/refresh.ts` scheduling.
- Migration `0014_content_refresh.sql`.
