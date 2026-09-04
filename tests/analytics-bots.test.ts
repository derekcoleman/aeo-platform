import { describe, expect, it } from "vitest";
import { classifyUserAgent, ipInCidr, parseIp, parsePublishedRanges, verifyBotIp } from "@/lib/analytics/bots";
import { hashIp } from "@/lib/analytics/crawl";

describe("classifyUserAgent", () => {
  it("prefers the user-triggered agent over the base crawler it shares a prefix with", () => {
    expect(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot")).toEqual({ family: "chatgpt-user", purpose: "live_fetch" });
    expect(classifyUserAgent("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toEqual({ family: "gptbot", purpose: "train" });
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)")?.purpose).toBe("live_fetch");
  });
  it("ignores browsers and empty agents", () => {
    expect(classifyUserAgent("Mozilla/5.0 (Macintosh) Chrome/120")).toBeNull();
    expect(classifyUserAgent(null)).toBeNull();
  });
});

describe("ip parsing and cidr", () => {
  it("parses v4, v6 and v4-mapped v6", () => {
    expect(parseIp("10.1.2.3")).toEqual({ version: 4, value: (10n << 24n) + (1n << 16n) + (2n << 8n) + 3n });
    expect(parseIp("::ffff:10.1.2.3")?.version).toBe(4);
    expect(parseIp("2001:db8::1")?.version).toBe(6);
    expect(parseIp("2001:db8::1")?.value).toBe((0x2001n << 112n) + (0x0db8n << 96n) + 1n);
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("2001:db8:::1")).toBeNull();
    expect(parseIp("")).toBeNull();
  });
  it("matches inside the prefix and rejects outside or cross-version", () => {
    expect(ipInCidr("20.15.240.77", "20.15.240.64/28")).toBe(true);
    expect(ipInCidr("20.15.240.80", "20.15.240.64/28")).toBe(false);
    expect(ipInCidr("2001:db8:1::5", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::5", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("10.0.0.1", "10.0.0.1")).toBe(true);
    expect(ipInCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
  });
  it("verifies only against a family with published ranges", () => {
    const ranges = { gptbot: ["20.15.240.64/28"] };
    expect(verifyBotIp("gptbot", "20.15.240.70", ranges)).toBe(true);
    expect(verifyBotIp("gptbot", "1.2.3.4", ranges)).toBe(false);
    expect(verifyBotIp("gptbot", null, ranges)).toBe(false);
    expect(verifyBotIp("claudebot", "1.2.3.4", ranges)).toBeNull();
  });
});

describe("published ranges", () => {
  it("reads the operators' common prefixes shape and a bare list", () => {
    expect(parsePublishedRanges({ creationTime: "x", prefixes: [{ ipv4Prefix: "20.15.240.64/28" }, { ipv6Prefix: "2001:db8::/32" }, { junk: 1 }] })).toEqual(["20.15.240.64/28", "2001:db8::/32"]);
    expect(parsePublishedRanges(["1.2.3.0/24", "nope"])).toEqual(["1.2.3.0/24"]);
    expect(parsePublishedRanges(null)).toEqual([]);
  });
});

describe("hashIp", () => {
  it("is salted, stable and never the address", () => {
    const a = hashIp("1.2.3.4", "s1");
    expect(a).toHaveLength(24);
    expect(a).toBe(hashIp("1.2.3.4", "s1"));
    expect(a).not.toBe(hashIp("1.2.3.4", "s2"));
    expect(a).not.toContain("1.2.3.4");
  });
});
