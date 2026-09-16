import type postgres from "postgres";
import { appDb } from "@/lib/db/app";

/**
 * Evidence that the job runner executes functions against this database.
 * `cron` is beaten by the five-minute site-health-monitor; the two `ping`
 * keys record a test event's send and receipt (Ops → Setup). The rows are
 * read by the setup checklist, which is the only consumer.
 */

export type HeartbeatKey = "cron" | "ping:sent" | "ping:received";

export interface HeartbeatRow {
  key: string;
  seen_at: string | Date;
  deployment: string | null;
  detail: Record<string, unknown>;
}

export function deploymentLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.VERCEL_DEPLOYMENT_ID?.trim() || env.VERCEL_URL?.trim() || null;
}

const MISSING_TABLE = "42P01";

export async function recordHeartbeat(key: HeartbeatKey, detail: Record<string, unknown> = {}, sql: postgres.Sql = appDb(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await sql`
    insert into ops.job_heartbeats (key, seen_at, deployment, detail)
    values (${key}, now(), ${deploymentLabel(env)}, ${sql.json(detail as never)})
    on conflict (key) do update set seen_at = excluded.seen_at, deployment = excluded.deployment, detail = excluded.detail`;
}

/** Like recordHeartbeat, but a database that predates migration 0017 is not an error: the beat is simply not recorded. */
export async function tryRecordHeartbeat(key: HeartbeatKey, detail: Record<string, unknown> = {}, sql?: postgres.Sql): Promise<boolean> {
  try {
    await recordHeartbeat(key, detail, sql);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === MISSING_TABLE) return false;
    throw e;
  }
}

/** Every heartbeat row, or null when migration 0017 has not been applied. */
export async function readHeartbeats(sql: postgres.Sql = appDb()): Promise<HeartbeatRow[] | null> {
  try {
    return await sql<HeartbeatRow[]>`select key, seen_at, deployment, detail from ops.job_heartbeats`;
  } catch (e) {
    if ((e as { code?: string }).code === MISSING_TABLE) return null;
    throw e;
  }
}
