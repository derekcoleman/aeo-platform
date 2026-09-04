import { describe, expect, it } from "vitest";
import { hmacHex, requestSignatureInput, timingSafeEqualHex, verifyBodySignature, verifyRequestSignature } from "@/lib/tenancy/signature";

const SECRET = "0123456789abcdef0123456789abcdef";
const T = Date.UTC(2026, 8, 4, 12, 30, 20);

describe("request signature", () => {
  it("accepts the current minute and one either side, rejects further skew", async () => {
    const minute = Math.floor(T / 60_000);
    const sig = await hmacHex(SECRET, requestSignatureInput("acme.com", "/resources/a", minute));
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/a", sig, T)).toBe(true);
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/a", sig, T + 60_000)).toBe(true);
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/a", sig, T - 60_000)).toBe(true);
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/a", sig, T + 130_000)).toBe(false);
  });
  it("is bound to host, path and secret", async () => {
    const minute = Math.floor(T / 60_000);
    const sig = await hmacHex(SECRET, requestSignatureInput("acme.com", "/resources/a", minute));
    expect(await verifyRequestSignature(SECRET, "evil.com", "/resources/a", sig, T)).toBe(false);
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/b", sig, T)).toBe(false);
    expect(await verifyRequestSignature("other", "acme.com", "/resources/a", sig, T)).toBe(false);
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/a", "not-hex", T)).toBe(false);
    expect(await verifyRequestSignature(SECRET, "acme.com", "/resources/a", null, T)).toBe(false);
  });
});

describe("body signature", () => {
  it("round-trips and rejects a tampered body", async () => {
    const body = JSON.stringify({ siteId: "x", events: [{ path: "/a" }] });
    const sig = await hmacHex(SECRET, body);
    expect(await verifyBodySignature(SECRET, body, sig)).toBe(true);
    expect(await verifyBodySignature(SECRET, body, sig.toUpperCase())).toBe(true);
    expect(await verifyBodySignature(SECRET, body + " ", sig)).toBe(false);
  });
});

describe("timingSafeEqualHex", () => {
  it("compares equal-length strings and rejects length mismatch", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
  });
});
