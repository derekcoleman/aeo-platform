import { describe, expect, it } from "vitest";
import { isOwnedUrl, stripWww, vectorLiteral } from "@/lib/demand/store";
import { batchBySite } from "@/lib/inngest/demand";
import { cosine, hashEmbedder, normalize } from "@/lib/ai/embed";

describe("ownership", () => {
  const own = { domains: ["acme.com", "acme.io"] };
  it("strips www", () => {
    expect(stripWww("WWW.Acme.com")).toBe("acme.com");
    expect(stripWww("acme.com")).toBe("acme.com");
  });
  it("matches canonical and alias domains including www and subdomains", () => {
    expect(isOwnedUrl("https://www.acme.com/resources/x", own)).toBe(true);
    expect(isOwnedUrl("https://docs.acme.io/x", own)).toBe(true);
    expect(isOwnedUrl("https://acme.com.evil.com/x", own)).toBe(false);
    expect(isOwnedUrl("https://notacme.com/x", own)).toBe(false);
    expect(isOwnedUrl("garbage", own)).toBe(false);
  });
});

describe("vectorLiteral", () => {
  it("renders a pgvector literal and zeroes non-finite values", () => {
    expect(vectorLiteral([1, 0.5, Number.NaN])).toBe("[1.0000000,0.5000000,0]");
  });
});

describe("hashEmbedder", () => {
  it("is deterministic, unit-length and similarity-preserving", async () => {
    const e = hashEmbedder(64);
    const [a, b, c] = await e.embed(["what is scim provisioning", "what is scim provisioning?", "best pizza in rome"]);
    expect(a).toEqual(b);
    expect(cosine(a!, b!)).toBeCloseTo(1);
    expect(cosine(a!, c!)).toBeLessThan(0.5);
    expect(Math.hypot(...normalize([3, 4]))).toBeCloseTo(1);
  });
});

describe("batchBySite", () => {
  it("groups by site and splits into batches", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, site_id: i < 3 ? "s1" : "s2", org_id: i < 3 ? "o1" : "o2", text: "", locale: "us-en", device: "desktop", tracking_tier: "weekly" as const }));
    const out = batchBySite(rows, 2);
    expect(out).toEqual([
      { siteId: "s1", orgId: "o1", questionIds: ["q0", "q1"] },
      { siteId: "s1", orgId: "o1", questionIds: ["q2"] },
      { siteId: "s2", orgId: "o2", questionIds: ["q3", "q4"] },
    ]);
  });
});
