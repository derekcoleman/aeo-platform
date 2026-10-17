import { describe, expect, it } from "vitest";
import type { GateStep } from "@/lib/pipeline/gate";
import { heldFor, holdWhilePaused, publishGuard, publishVelocity, velocityCap, velocityVerdict, VELOCITY_WINDOW_DAYS } from "@/lib/pipeline/guard";
import { fakeSql } from "./helpers/fake-sql";
import { ORG_ID, SITE_ID } from "./fixtures/pipeline";

const env = {} as NodeJS.ProcessEnv;
const weekly = (perWeek: number) => perWeek * 13;

describe("velocityCap", () => {
  it("starts a new site at 2 a week", () => {
    expect(velocityCap(0, env)).toBe(2);
  });

  it("grows with the site's own cadence: 1.5× its trailing weekly pace, never above 5", () => {
    expect(velocityCap(weekly(1), env)).toBe(2);
    expect(velocityCap(weekly(2), env)).toBe(3);
    expect(velocityCap(weekly(3), env)).toBe(5);
    expect(velocityCap(weekly(4), env)).toBe(5);
    expect(velocityCap(weekly(20), env)).toBe(5);
  });

  it("takes a staff ceiling from AEO_PUBLISH_VELOCITY_MAX; a ceiling of 1 throttles every site; nonsense is ignored", () => {
    expect(velocityCap(weekly(6), { AEO_PUBLISH_VELOCITY_MAX: "8" } as unknown as NodeJS.ProcessEnv)).toBe(8);
    expect(velocityCap(0, { AEO_PUBLISH_VELOCITY_MAX: "8" } as unknown as NodeJS.ProcessEnv)).toBe(2);
    expect(velocityCap(weekly(4), { AEO_PUBLISH_VELOCITY_MAX: "1" } as unknown as NodeJS.ProcessEnv)).toBe(1);
    expect(velocityCap(weekly(4), { AEO_PUBLISH_VELOCITY_MAX: "0" } as unknown as NodeJS.ProcessEnv)).toBe(5);
    expect(velocityCap(weekly(4), { AEO_PUBLISH_VELOCITY_MAX: " " } as unknown as NodeJS.ProcessEnv)).toBe(5);
    expect(velocityCap(weekly(4), { AEO_PUBLISH_VELOCITY_MAX: "lots" } as unknown as NodeJS.ProcessEnv)).toBe(5);
  });
});

describe("velocityVerdict", () => {
  const nextSlotAt = new Date("2026-09-08T10:00:00Z");

  it("lets a site under its pace publish", () => {
    expect(velocityVerdict({ cap: 2, published7d: 1, published90d: 0, nextSlotAt })).toEqual({ ok: true });
  });

  it("holds a site at its pace until the oldest publish in the window leaves it", () => {
    const v = velocityVerdict({ cap: 2, published7d: 2, published90d: 4, nextSlotAt });
    expect(v).toEqual({ ok: false, reason: "this project has published 2 pages in the last 7 days, its pace allows 2", until: nextSlotAt });
    expect(heldFor(v as Exclude<typeof v, { ok: true }>)).toEqual({ held: v.ok ? "" : v.reason, until: "2026-09-08T10:00:00.000Z" });
  });
});

describe("publishVelocity and the guard", () => {
  it("counts the site's publishes (new and refreshed) in the window and the trailing 90 days", async () => {
    const oldest = new Date("2026-09-02T08:00:00Z");
    const sql = fakeSql([[/from content\.content_items/, () => [{ published_7d: 3, published_90d: weekly(2), oldest_7d: oldest }]]]);
    const v = await publishVelocity(SITE_ID, sql, env);
    expect(v).toEqual({ cap: 3, published7d: 3, published90d: 26, nextSlotAt: new Date(oldest.getTime() + VELOCITY_WINDOW_DAYS * 86_400_000) });
    const q = sql.queries[0]!;
    expect(q.text).toContain("where site_id = $");
    expect(q.text).toContain("published_at >= now() - make_interval(days => $");
    expect(q.text).toContain("pipeline_published_at >= now() - make_interval(days => $");
    expect(q.text).toContain("and id is distinct from $");
    expect(q.values).toEqual([7, null, 7, null, SITE_ID, 90]);
  });

  it("checks the pace only when asked, and only after the kill switch lets the site publish", async () => {
    const full = () =>
      fakeSql([
        [/from app\.sites where id/, () => [{ org_id: ORG_ID, status: "active", indexing_paused: false }]],
        [/from content\.content_items/, () => [{ published_7d: 2, published_90d: 2, oldest_7d: new Date("2026-09-02T08:00:00Z") }]],
      ]);
    const plain = full();
    expect(await publishGuard(SITE_ID, plain)).toEqual({ ok: true });
    expect(plain.queries.some((q) => q.text.includes("content.content_items"))).toBe(false);
    expect(await publishGuard(SITE_ID, full(), { velocity: true, env })).toMatchObject({ ok: false, until: new Date("2026-09-09T08:00:00Z") });
    // The pipeline names the item it publishes, which the window leaves out.
    const own = full();
    await publishGuard(SITE_ID, own, { velocity: true, contentItemId: "item-1", env });
    expect(own.queries.find((q) => q.text.includes("content.content_items"))!.values).toEqual([7, "item-1", 7, "item-1", SITE_ID, 90]);

    const paused = fakeSql([[/from app\.sites where id/, () => [{ org_id: ORG_ID, status: "paused", indexing_paused: false }]]]);
    expect(await publishGuard(SITE_ID, paused, { velocity: true, env })).toEqual({ ok: false, reason: "the project is paused" });
    expect(paused.queries.some((q) => q.text.includes("content.content_items"))).toBe(false);
  });

  it("a held publish sleeps until the slot frees, not an hour at a time", async () => {
    const sleeps: string[] = [];
    const step = {
      async sleep(id: string, d: string) { sleeps.push(`${id} ${d}`); },
      async sleepUntil(id: string, at: Date) { sleeps.push(`${id} until ${at.toISOString()}`); },
    } as unknown as Pick<GateStep, "sleep" | "sleepUntil">;
    const r = await holdWhilePaused(step, async (n) => (n === 0 ? { held: "pace", until: "2026-09-09T08:00:00.000Z" } : n === 1 ? { held: "the project is paused" } : { path: "/resources/x" }));
    expect(r).toEqual({ path: "/resources/x" });
    expect(sleeps).toEqual(["publish:hold:0 until 2026-09-09T08:00:00.000Z", "publish:hold:1 1h"]);
  });
});
