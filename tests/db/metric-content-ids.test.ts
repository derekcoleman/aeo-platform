import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetAttribution, siteSignals } from "@/lib/app/attribution";
import { currentRestatements, METHODOLOGY_PAGE_METRICS } from "@/lib/app/methodology";
import { computeRestatement } from "@/lib/app/restatement";
import { CONTENT_ID_LOOKBACK_DAYS, resolveMetricContentIds } from "@/lib/connectors/store";

/**
 * Per-asset attribution against the real schema: GA4 landing pages and
 * Search Console page URLs resolve to the content item behind them (a
 * published page, or a CMS post linked to one), only on hosts the site owns,
 * and the site's click total counts each click once. Runs only with
 * AEO_TEST_DATABASE_URL; everything it creates is under one throwaway
 * organisation, removed at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("metric content ids against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const ORG = randomUUID();
  const SITE = randomUUID();
  const CONN = randomUUID();
  const GUIDE = randomUUID();
  const OLD_POST = randomUUID();
  const HOST = `acme-${SITE.slice(0, 8)}.test`;

  const metric = (provider: string, surface: string, dimension: Record<string, string>, daysAgo: number, metrics: Record<string, number>) => sql`
    insert into measure.external_metrics (site_id, provider, surface, dimension, date, metrics)
    values (${SITE}, ${provider}, ${surface}, ${sql.json(dimension)}, current_date - ${daysAgo}::int, ${sql.json(metrics)})`;

  beforeAll(async () => {
    await sql`insert into app.organizations (id, name, slug) values (${ORG}, 'Content ids test', ${`ids-${ORG.slice(0, 8)}`})`;
    await sql`insert into app.sites (id, org_id, name, canonical_domain, path_prefix, edge_hostname, status)
      values (${SITE}, ${ORG}, 'Content ids test', ${HOST}, '/resources', ${`ids-${SITE.slice(0, 8)}.blogedge.test`}, 'active')`;
    await sql`insert into content.content_items (id, site_id, slug, status, published_at) values
      (${GUIDE}, ${SITE}, 'guide', 'published', now() - interval '20 days'),
      (${OLD_POST}, ${SITE}, 'old-post', 'published', now() - interval '20 days')`;
    await sql`insert into content.published_pages (site_id, path, content_item_id, html, etag) values (${SITE}, '/resources/guide', ${GUIDE}, '<h1>Guide</h1>', 'e1')`;
    await sql`insert into context.context_connections (id, org_id, site_id, provider) values (${CONN}, ${ORG}, ${SITE}, 'webflow')`;
    await sql`insert into content.cms_items (site_id, connection_id, external_site_id, collection_id, collection_name, collection_slug, external_id, url, url_key, content_item_id)
      values (${SITE}, ${CONN}, 'wf', 'c1', 'Blog', 'blog', 'i1', ${`https://www.${HOST}/blog/old-post`}, content.url_key(${`https://www.${HOST}/blog/old-post`}), ${OLD_POST})`;

    await metric("ga4", "ga4_referral", { engine: "chatgpt", source: "chatgpt.com", landingPage: "/resources/guide/" }, 1, { sessions: 7 });
    await metric("ga4", "ga4_referral", { engine: "chatgpt", source: "chatgpt.com", landingPage: "/resources/unknown" }, 1, { sessions: 4 });
    await metric("gsc", "gsc_page", { page: `https://www.${HOST}/resources/guide` }, 2, { clicks: 5, impressions: 50 });
    // The same five clicks, cut by query: summing both reports counted them twice.
    await metric("gsc", "gsc_query", { query: "scim guide" }, 2, { clicks: 5, impressions: 50 });
    await metric("gsc", "gsc_page", { page: `https://${HOST}/blog/old-post?utm_source=x` }, 3, { clicks: 3, impressions: 30 });
    // Same path on a host the site does not own (a domain property covers subdomains): never ours.
    await metric("gsc", "gsc_page", { page: `https://docs.${HOST}/resources/guide` }, 2, { clicks: 9, impressions: 90 });
    // The refresh scan's site-wide window: matched by URL key, never resolved (nothing reads its content_id).
    await metric("gsc", "gsc_page_window", { page: `https://www.${HOST}/resources/guide`, window: "current", days: "28" }, 2, { clicks: 40, impressions: 400 });
    // Older than any window that reads content_id: the nightly pass leaves it, an explicit window reaches it.
    await metric("ga4", "ga4_referral", { engine: "perplexity", source: "perplexity.ai", landingPage: "/resources/guide" }, 90, { sessions: 2 });

    const [snap] = await sql<{ id: string }[]>`
      insert into measure.questions (site_id, text, normalized, source, locale, device) values (${SITE}, 'q', 'q', 'manual', 'us-en', 'desktop') returning id`;
    const [s] = await sql<{ id: string }[]>`
      insert into measure.serp_snapshots (site_id, question_id, provider, locale, device, aio_triggered) values (${SITE}, ${snap!.id}, 'serpapi', 'us-en', 'desktop', true) returning id`;
    await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
      values (${SITE}, ${s!.id}, 'ai_overview', ${`https://${HOST}/resources/guide/`}, ${HOST}, 1, true)`;
  });

  afterAll(async () => {
    await sql`delete from app.organizations where id = ${ORG}`;
    await sql.end();
  });

  const resolved = async () =>
    sql<{ surface: string; key: string; content_id: string | null }[]>`
      select surface, coalesce(dimension->>'landingPage', dimension->>'page', dimension->>'query') as key, content_id
      from measure.external_metrics where site_id = ${SITE} order by surface, key`;

  it("ties GA4 landing pages and Search Console URLs to the asset behind them, on owned hosts only", async () => {
    // A sync resolves only the window it wrote.
    expect(await resolveMetricContentIds(SITE, sql, { since: "2999-01-01" })).toEqual({ metrics: 0, citations: 1 });
    // Without a window: the last CONTENT_ID_LOOKBACK_DAYS, on the surfaces attribution reads.
    expect(CONTENT_ID_LOOKBACK_DAYS).toBe(60);
    expect(await resolveMetricContentIds(SITE, sql)).toEqual({ metrics: 3, citations: 0 });
    expect(await resolved()).toEqual([
      { surface: "ga4_referral", key: "/resources/guide", content_id: null },
      { surface: "ga4_referral", key: "/resources/guide/", content_id: GUIDE },
      { surface: "ga4_referral", key: "/resources/unknown", content_id: null },
      { surface: "gsc_page", key: `https://${HOST}/blog/old-post?utm_source=x`, content_id: OLD_POST },
      { surface: "gsc_page", key: `https://docs.${HOST}/resources/guide`, content_id: null },
      { surface: "gsc_page", key: `https://www.${HOST}/resources/guide`, content_id: GUIDE },
      { surface: "gsc_page_window", key: `https://www.${HOST}/resources/guide`, content_id: null },
      { surface: "gsc_query", key: "scim guide", content_id: null },
    ]);
    const [cite] = await sql<{ content_id: string | null }[]>`select content_id from measure.serp_citations where site_id = ${SITE}`;
    expect(cite!.content_id).toBe(GUIDE);
    // Idempotent.
    expect(await resolveMetricContentIds(SITE, sql)).toEqual({ metrics: 0, citations: 0 });
    // A sync that wrote an older window resolves it.
    const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    expect(await resolveMetricContentIds(SITE, sql, { since })).toEqual({ metrics: 1, citations: 0 });
    expect((await resolved()).filter((r) => r.content_id === null).map((r) => r.surface)).toEqual(["ga4_referral", "gsc_page", "gsc_page_window", "gsc_query"]);
  });

  it("per-asset attribution reads the resolved rows; the site total counts each click once", async () => {
    const assets = new Map((await assetAttribution(SITE, 100, sql)).map((a) => [a.id, a]));
    expect(assets.get(GUIDE)).toMatchObject({ ai_sessions_30d: 7, gsc_clicks_28d: 5, gsc_impressions_28d: 50, aio_questions_30d: 1 });
    expect(assets.get(OLD_POST)).toMatchObject({ ai_sessions_30d: 0, gsc_clicks_28d: 3 });
    const signals = await siteSignals(SITE, sql);
    expect(signals).toMatchObject({ gsc_clicks_28d: 17, ai_sessions_30d: 11, has_ga4: true, has_gsc: true });
  });

  it("restates the click total, the per-asset numbers and the Refresh page's cited posts", async () => {
    // The CMS post ranks organically in one of our snapshots and is cited by a Profound engine:
    // the refresh scan counted the ranking as a native citation, and neither is an AI Overview citation now.
    const [q] = await sql<{ id: string }[]>`select id from measure.questions where site_id = ${SITE} limit 1`;
    const cite = async (provider: string, surface: string) => {
      const [s] = await sql<{ id: string }[]>`
        insert into measure.serp_snapshots (site_id, question_id, provider, locale, device, aio_triggered) values (${SITE}, ${q!.id}, ${provider}, 'us-en', 'desktop', false) returning id`;
      await sql`insert into measure.serp_citations (site_id, serp_snapshot_id, surface, url, domain, position, is_owned)
        values (${SITE}, ${s!.id}, ${surface}, ${`https://www.${HOST}/blog/old-post`}, ${HOST}, 3, true)`;
    };
    await cite("serpapi", "organic");
    await cite("profound", "ai_overview");

    const byMetric = Object.fromEntries((await computeRestatement(SITE, sql)).map((r) => [r.metric, [r.oldValue, r.newValue]]));
    expect(byMetric.gsc_clicks_28d).toEqual([22, 17]);
    expect(byMetric.asset_gsc_clicks_28d).toEqual([0, 8]);
    expect(byMetric.asset_ai_sessions_30d).toEqual([0, 7]);
    expect(byMetric.refresh_cited_posts).toEqual([1, 0]);
    expect((await currentRestatements(SITE, METHODOLOGY_PAGE_METRICS.refresh, sql)).map((r) => [r.metric, r.old_value, r.new_value])).toEqual([["refresh_cited_posts", 1, 0]]);
  });
});
