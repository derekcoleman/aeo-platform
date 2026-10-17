import type postgres from "postgres";
import { resolveMetricContentIds } from "@/lib/connectors/store";
import { appDb } from "@/lib/db/app";
import { citationGaps } from "@/lib/demand/store";
import { loadInventorySignals } from "@/lib/refresh/scan";
import { topicStats } from "@/lib/strategy/topics";
import { assetAttribution, siteSignals } from "./attribution";
import { DEMAND_GAP_LIMIT, demandCounts } from "./demand";
import { legacyAssetTotals, legacyGscClicks28d, legacyOpenGaps, legacyRefreshCitedPosts, legacySnapshots7d, legacyTopicGaps } from "./methodology-legacy";
import { METHODOLOGY_VERSION, RESTATED_METRICS, type RestatedMetric } from "./methodology";

/**
 * Restate a site's headline numbers under the current methodology: each
 * metric computed the old way (lib/app/methodology-legacy.ts) and the new
 * way, written to app.metric_restatements, one row per metric and version,
 * replaced on a re-run. The methodology note on Strategy, Demand and
 * Attribution reads these rows. Lives apart from lib/app/methodology.ts so
 * the read models can import the version without importing each other.
 */

export interface Restatement {
  metric: RestatedMetric;
  oldValue: number;
  newValue: number;
  reason: string;
}

/** The asset read model returns a ranked, capped list; a restatement sums it whole. */
const UNCAPPED = 100_000;

export async function computeRestatement(siteId: string, sql: postgres.Sql = appDb()): Promise<Restatement[]> {
  // The new per-asset numbers read content_id; make sure what can be resolved is.
  await resolveMetricContentIds(siteId, sql);
  const [gapsOld, topicGapsOld, snapshotsOld, clicksOld, assetsOld, refreshOld, gaps, topics, counts, signals, assets, inventory] = await Promise.all([
    legacyOpenGaps(siteId, sql),
    legacyTopicGaps(siteId, sql),
    legacySnapshots7d(siteId, sql),
    legacyGscClicks28d(siteId, sql),
    legacyAssetTotals(siteId, sql),
    legacyRefreshCitedPosts(siteId, sql),
    citationGaps(siteId, DEMAND_GAP_LIMIT, sql),
    topicStats(siteId, sql),
    demandCounts(siteId, sql),
    siteSignals(siteId, sql),
    assetAttribution(siteId, UNCAPPED, sql),
    loadInventorySignals(siteId, sql),
  ]);
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const values: Record<RestatedMetric, [number, number]> = {
    // Demand's badge counts its list, which stops at DEMAND_GAP_LIMIT, before and after.
    open_gaps: [Math.min(gapsOld, DEMAND_GAP_LIMIT), gaps.length],
    topic_gaps: [topicGapsOld, sum([...topics.values()].map((t) => t.gaps))],
    snapshots_7d: [snapshotsOld, counts.snapshots_7d],
    gsc_clicks_28d: [clicksOld, signals.gsc_clicks_28d],
    asset_gsc_clicks_28d: [assetsOld.gsc_clicks_28d, sum(assets.map((a) => a.gsc_clicks_28d))],
    asset_ai_sessions_30d: [assetsOld.ai_sessions_30d, sum(assets.map((a) => a.ai_sessions_30d))],
    refresh_cited_posts: [refreshOld, inventory.filter((i) => i.cited_native > 0).length],
  };
  const out: Restatement[] = [];
  for (const metric of Object.keys(RESTATED_METRICS) as RestatedMetric[]) {
    const [oldValue, newValue] = values[metric];
    const reason = RESTATED_METRICS[metric].reason;
    await sql`
      insert into app.metric_restatements (site_id, metric, old_value, new_value, methodology_version, reason)
      values (${siteId}, ${metric}, ${oldValue}, ${newValue}, ${METHODOLOGY_VERSION}, ${reason})
      on conflict (site_id, metric, methodology_version) do update
        set old_value = excluded.old_value, new_value = excluded.new_value, reason = excluded.reason, computed_at = now()`;
    out.push({ metric, oldValue, newValue, reason });
  }
  return out;
}

/** The audit trail for a staff-triggered restatement: who asked, and every number it moved. */
export async function auditRestatement(site: { id: string; org_id: string }, rows: Restatement[], actorUserId: string | null, sql: postgres.Sql = appDb()): Promise<void> {
  const changed = rows.filter((r) => r.oldValue !== r.newValue).map((r) => ({ metric: r.metric, old: r.oldValue, new: r.newValue }));
  await sql`
    insert into app.audit_log (org_id, actor_user_id, action, target_type, target_id, after)
    values (${site.org_id}, ${actorUserId}, 'metrics.restate', 'site', ${site.id}, ${sql.json({ methodologyVersion: METHODOLOGY_VERSION, changed } as never)})`;
}

/** Every site a restatement could say something about: one with snapshots or connector metrics. */
export async function sitesWithMeasurements(sql: postgres.Sql = appDb()): Promise<{ id: string; org_id: string }[]> {
  return sql<{ id: string; org_id: string }[]>`
    select s.id, s.org_id from app.sites s
    where exists (select 1 from measure.serp_snapshots x where x.site_id = s.id)
       or exists (select 1 from measure.external_metrics m where m.site_id = s.id)
    order by s.id`;
}
