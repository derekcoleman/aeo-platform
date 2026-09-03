import { describe, expect, it } from "vitest";
import { AuditError, normalizeTargetUrl, prioritizePages } from "@/lib/audit";

describe("normalizeTargetUrl", () => {
  it("adds https, strips hash and credentials", () => {
    const u = normalizeTargetUrl(" acme.com/path#frag ");
    expect(u.toString()).toBe("https://acme.com/path");
    expect(normalizeTargetUrl("http://u:p@acme.com/").toString()).toBe("http://acme.com/");
  });
  it("rejects garbage and bare hostnames", () => {
    expect(() => normalizeTargetUrl("not a url")).toThrow(AuditError);
    expect(() => normalizeTargetUrl("localhost")).toThrow(/public hostname/);
  });
});

describe("prioritizePages", () => {
  it("takes one of each priority section before the long tail, deduped, within limit", () => {
    const urls = [
      "https://a.com/x1", "https://a.com/x2", "https://a.com/pricing", "https://a.com/blog/one",
      "https://a.com/blog/two", "https://a.com/about", "https://a.com/x1",
    ];
    const out = prioritizePages(urls, 4);
    expect(out).toHaveLength(4);
    expect(new Set(out).size).toBe(4);
    expect(out).toEqual(expect.arrayContaining(["https://a.com/about", "https://a.com/blog/one", "https://a.com/pricing"]));
  });
});
