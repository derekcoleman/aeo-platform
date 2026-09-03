import { describe, expect, it } from "vitest";
import { luhnValid, redact } from "@/lib/context/redact";

describe("redact", () => {
  it("replaces emails, phones, Luhn-valid cards and credentials with fixed tokens", () => {
    const r = redact("Ping dana@acme.com or +1 (415) 555-0134; card 4242 4242 4242 4242; token xoxb-1234567890-abcdefghij");
    expect(r.text).toBe("Ping [email] or [phone]; card [card]; token [secret]");
    expect(r.counts).toEqual({ email: 1, phone: 1, card: 1, secret: 1 });
    expect(r.changed).toBe(true);
  });

  it("leaves order ids, version numbers and bare digit runs alone", () => {
    const text = "order 1234 5678 9012 3450 shipped; v2.14.3; 1200000000 rows; since 2019";
    const r = redact(text);
    expect(r.text).toBe(text);
    expect(r.changed).toBe(false);
  });

  it("protects Slack mentions and URLs, including ones that contain email-like or digit-heavy strings", () => {
    const text = "<@U024BE7LH> see <#C1234567890|ops> and https://acme.com/u/dana@acme.com?id=4242424242424242 before 2026";
    expect(redact(text).text).toBe(text);
  });

  it("catches every credential shape we know about, including PEM blocks and bearer headers", () => {
    const secrets = [
      "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "AKIAIOSFODNN7EXAMPLE",
      "ya29.a0AfH6SMBabcdefghijklmnop",
      "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ];
    for (const s of secrets) {
      const r = redact(`here: ${s} done`);
      expect(r.text, s).toBe("here: [secret] done");
    }
  });

  it("luhnValid accepts a test card and rejects an off-by-one", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("123")).toBe(false);
  });
});
