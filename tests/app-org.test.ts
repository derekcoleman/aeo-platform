import { describe, expect, it } from "vitest";
import { acceptInvitesFor, canAssignRole, wouldRemoveLastOwner } from "@/lib/app/org";
import { purgeExpired } from "@/lib/ops/retention";
import { emailConfigured, sendEmail } from "@/lib/notify/email";
import { fakeSql } from "./helpers/fake-sql";

describe("role rules", () => {
  it("owners may assign anything; admins only editor/viewer to non-privileged members", () => {
    expect(canAssignRole("owner", "admin", "owner")).toBe(true);
    expect(canAssignRole("admin", null, "editor")).toBe(true);
    expect(canAssignRole("admin", null, "admin")).toBe(false);
    expect(canAssignRole("admin", "admin", "viewer")).toBe(false);
    expect(canAssignRole("admin", "owner", "viewer")).toBe(false);
    expect(canAssignRole("editor", null, "viewer")).toBe(false);
  });
  it("never lets the last owner be demoted or removed", () => {
    const members = [{ user_id: "a", role: "owner" as const }, { user_id: "b", role: "editor" as const }];
    expect(wouldRemoveLastOwner(members, "a", "admin")).toBe(true);
    expect(wouldRemoveLastOwner(members, "a", null)).toBe(true);
    expect(wouldRemoveLastOwner(members, "b", null)).toBe(false);
    expect(wouldRemoveLastOwner([...members, { user_id: "c", role: "owner" as const }], "a", "viewer")).toBe(false);
  });
});

describe("acceptInvitesFor", () => {
  it("turns pending invites for the email into memberships and audits each", async () => {
    const sql = fakeSql([[/update app\.org_invites/, () => [{ id: "i1", org_id: "o1", role: "editor" }]]]);
    expect(await acceptInvitesFor("u1", "New@Acme.com", sql)).toBe(1);
    const texts = sql.queries.map((q) => q.text);
    expect(texts[1]).toContain("insert into app.memberships");
    expect(sql.queries[1]!.values).toEqual(["u1", "o1", "editor"]);
    expect(texts[2]).toContain("insert into app.audit_log");
  });
  it("does nothing without an email", async () => {
    const sql = fakeSql();
    expect(await acceptInvitesFor("u1", null, sql)).toBe(0);
    expect(sql.queries).toHaveLength(0);
  });
});

describe("purgeExpired", () => {
  it("deletes by the org's retention window and the fixed windows for raw telemetry and caches", async () => {
    const sql = fakeSql([[/select count\(\*\)::int as n from gone/, () => [{ n: 2 }]]]);
    const s = await purgeExpired(sql, new Date("2026-09-04T03:30:00Z"));
    expect(s).toEqual({ documents: 2, crawlEvents: 2, serpCache: 2, webhookEvents: 2 });
    expect(sql.queries[0]!.text).toContain("make_interval(days => o.retention_days)");
    expect(sql.queries[1]!.text).toContain("interval '90 days'");
    expect(sql.queries[3]!.text).toContain("processed_at is not null");
  });
});

describe("email", () => {
  it("is a documented no-op without configuration", async () => {
    expect(emailConfigured({})).toBe(false);
    const r = await sendEmail({ to: ["a@b.co"], subject: "x", text: "y" }, {});
    expect(r.sent).toBe(false);
    expect(r.reason).toContain("RESEND_API_KEY");
  });
  it("posts to Resend when configured", async () => {
    let body = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch;
    const r = await sendEmail({ to: ["a@b.co"], subject: "Hello", text: "Body" }, { RESEND_API_KEY: "re_x", ALERT_EMAIL_FROM: "AEO <alerts@x.co>" }, fetchImpl);
    expect(r).toEqual({ sent: true, id: "em_1" });
    expect(JSON.parse(body)).toMatchObject({ from: "AEO <alerts@x.co>", to: ["a@b.co"], subject: "Hello" });
  });
});
