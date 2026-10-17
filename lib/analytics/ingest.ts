import { NextResponse } from "next/server";
import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { verifyBodySignature } from "@/lib/tenancy/signature";
import { loadBotRanges } from "./crawl";

/**
 * Shared by the telemetry routes: authenticate a post from a customer's
 * Worker (body signature over the per-site secret), and cache the bot ranges
 * so a burst of hits does not hammer ops.bots.
 */

export interface IngestSite {
  id: string;
  org_id: string;
  proxy_hmac_secret: string;
}

export async function loadIngestSite(siteId: string, sql: postgres.Sql = appDb()): Promise<IngestSite | null> {
  const [row] = await sql<IngestSite[]>`select id, org_id, proxy_hmac_secret from app.sites where id = ${siteId} and status <> 'disabled'`;
  return row ?? null;
}

export type IngestAuth = { ok: true; site: IngestSite } | { ok: false; response: NextResponse };

export async function authenticateIngest(req: Request, rawBody: string, siteId: string, sql: postgres.Sql = appDb()): Promise<IngestAuth> {
  const headerSite = req.headers.get("x-aeo-site");
  if (headerSite && headerSite !== siteId) return { ok: false, response: NextResponse.json({ error: "site mismatch" }, { status: 400 }) };
  const site = await loadIngestSite(siteId, sql);
  if (!site) return { ok: false, response: NextResponse.json({ error: "unknown site" }, { status: 404 }) };
  if (!(await verifyBodySignature(site.proxy_hmac_secret, rawBody, req.headers.get("x-aeo-sig")))) {
    return { ok: false, response: NextResponse.json({ error: "bad signature" }, { status: 401 }) };
  }
  return { ok: true, site };
}

const RANGES_TTL_MS = 10 * 60_000;
let rangesCache: { at: number; ranges: Record<string, string[]> } | null = null;

export async function cachedBotRanges(sql: postgres.Sql = appDb(), now = Date.now()): Promise<Record<string, string[]>> {
  if (rangesCache && now - rangesCache.at < RANGES_TTL_MS) return rangesCache.ranges;
  const ranges = await loadBotRanges(sql);
  rangesCache = { at: now, ranges };
  return ranges;
}

export function resetBotRangesCache(): void {
  rangesCache = null;
}

const WORKER_VERSION_WRITE_MS = 60_000;
const workerVersionSeen = new Map<string, { version: string; at: number }>();

/**
 * Record the Worker version a site's telemetry reports, for the Install tab's
 * upgrade notice. Written at most once a minute per site: this instance's
 * memo skips the query, and the where clause skips the write when another
 * instance has just made it. A changed version is written at once.
 */
export async function noteWorkerVersion(siteId: string, version: string, sql: postgres.Sql = appDb(), now = Date.now()): Promise<boolean> {
  const last = workerVersionSeen.get(siteId);
  if (last && last.version === version && now - last.at < WORKER_VERSION_WRITE_MS) return false;
  workerVersionSeen.set(siteId, { version, at: now });
  const rows = await sql`
    update app.sites set worker_version = ${version}, worker_seen_at = now()
    where id = ${siteId}
      and (worker_version is distinct from ${version} or worker_seen_at is null or worker_seen_at < now() - interval '1 minute')
    returning id`;
  return rows.length > 0;
}

export function resetWorkerVersionMemo(): void {
  workerVersionSeen.clear();
}

/** Hash salt for source addresses. Falls back to the proxy secret so a fresh deployment still hashes consistently. */
export function ipHashSalt(env: NodeJS.ProcessEnv = process.env): string {
  return env.AEO_IP_HASH_SALT || env.AEO_PROXY_HMAC_SECRET || "aeo";
}
