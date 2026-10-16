import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { claimStaleWebhookEvents, claimWebhookEvent, markWebhookFailed, markWebhookProcessed } from "@/lib/connectors/store";

/**
 * The webhook ledger's claim semantics against the real schema (0005 + 0018):
 * the conditional upsert is the whole concurrency story, so it is tested
 * where the conflict actually happens. Runs only with AEO_TEST_DATABASE_URL
 * (CI's `database` job). Every row it writes uses a provider name unique to
 * this run and is deleted at the end.
 */
const DB_URL = process.env.AEO_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("webhook ledger against Postgres", () => {
  const sql = postgres(DB_URL ?? "postgres://invalid", { prepare: false, max: 4 });
  const PROVIDER = `test-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await sql`delete from ops.webhook_events where provider = ${PROVIDER}`;
    await sql.end();
  });

  const row = async (id: string) => {
    const [r] = await sql<{ attempts: number; claimed: boolean; processed: boolean; last_error: string | null }[]>`
      select attempts, claimed_at is not null as claimed, processed_at is not null as processed, last_error
      from ops.webhook_events where provider = ${PROVIDER} and external_id = ${id}`;
    return r;
  };

  it("claims a fresh event once; an immediate duplicate is refused", async () => {
    expect(await claimWebhookEvent(PROVIDER, "a", { n: 1 }, sql)).toBe(true);
    expect(await claimWebhookEvent(PROVIDER, "a", { n: 1 }, sql)).toBe(false);
    expect(await row("a")).toEqual({ attempts: 1, claimed: true, processed: false, last_error: null });
  });

  it("lets exactly one of two racing deliveries own the event", async () => {
    const results = await Promise.all([claimWebhookEvent(PROVIDER, "race", {}, sql), claimWebhookEvent(PROVIDER, "race", {}, sql)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("re-claims a released claim, counting the attempt and keeping the reason until then", async () => {
    await claimWebhookEvent(PROVIDER, "b", {}, sql);
    await markWebhookFailed(PROVIDER, "b", new Error("inngest unreachable"), sql);
    expect(await row("b")).toMatchObject({ claimed: false, last_error: "Error: inngest unreachable" });
    expect(await claimWebhookEvent(PROVIDER, "b", {}, sql)).toBe(true);
    expect(await row("b")).toMatchObject({ attempts: 2, claimed: true });
  });

  it("re-claims a lapsed lease, but not a live one", async () => {
    await claimWebhookEvent(PROVIDER, "c", {}, sql);
    expect(await claimWebhookEvent(PROVIDER, "c", {}, sql, 120)).toBe(false);
    await sql`update ops.webhook_events set claimed_at = now() - interval '5 minutes' where provider = ${PROVIDER} and external_id = 'c'`;
    expect(await claimWebhookEvent(PROVIDER, "c", {}, sql, 120)).toBe(true);
  });

  it("never re-claims a processed event, and a failure report cannot reopen it", async () => {
    await claimWebhookEvent(PROVIDER, "d", {}, sql);
    await markWebhookProcessed(PROVIDER, "d", sql);
    await markWebhookFailed(PROVIDER, "d", new Error("late"), sql);
    expect(await row("d")).toMatchObject({ processed: true, claimed: true, last_error: null });
    await sql`update ops.webhook_events set claimed_at = now() - interval '1 day' where provider = ${PROVIDER} and external_id = 'd'`;
    expect(await claimWebhookEvent(PROVIDER, "d", {}, sql)).toBe(false);
  });

  it("hands the re-drive only aged, unprocessed, unclaimed rows under the attempt cap, oldest first", async () => {
    const insert = (id: string, receivedAgo: string, extra: { attempts?: number; claimed?: string | null; processed?: boolean } = {}) => sql`
      insert into ops.webhook_events (provider, external_id, payload, received_at, attempts, claimed_at, processed_at)
      values (${PROVIDER}, ${id}, ${sql.json({ id } as never)}, now() - ${receivedAgo}::interval, ${extra.attempts ?? 1},
              ${extra.claimed === undefined ? null : extra.claimed === null ? null : sql`now() - ${extra.claimed}::interval`},
              ${extra.processed ? sql`now()` : null})`;
    await insert("stale-1", "40 minutes");
    await insert("stale-2", "20 minutes", { claimed: "10 minutes" });
    await insert("too-young", "2 minutes");
    await insert("capped", "30 minutes", { attempts: 5 });
    await insert("held", "30 minutes", { claimed: "30 seconds" });
    await insert("done", "30 minutes", { processed: true });
    await insert("ancient", "4 days");

    const claimed = await claimStaleWebhookEvents({ providers: [PROVIDER] }, sql);
    expect(claimed.map((r) => r.external_id)).toEqual(["stale-1", "stale-2"]);
    expect(claimed[0]).toMatchObject({ provider: PROVIDER, payload: { id: "stale-1" }, attempts: 2 });
    // Claimed now: a second run in the same window finds nothing.
    expect(await claimStaleWebhookEvents({ providers: [PROVIDER] }, sql)).toEqual([]);
  });
});
