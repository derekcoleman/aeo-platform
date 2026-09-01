import { describe, expect, it } from "vitest";
import { checkSsrf, isBlockedIpv4 } from "@/lib/fetch/ssrf";

describe("checkSsrf", () => {
  it("allows ordinary public hosts", () => {
    expect(checkSsrf("https://example.com/path").safe).toBe(true);
    expect(checkSsrf("http://93.184.216.34/").safe).toBe(true);
  });
  it("blocks private ranges precisely — 172.16/12, not all of 172.*", () => {
    expect(isBlockedIpv4("172.16.0.1")).toBe(true);
    expect(isBlockedIpv4("172.31.255.255")).toBe(true);
    expect(isBlockedIpv4("172.32.0.1")).toBe(false);
    expect(isBlockedIpv4("172.15.0.1")).toBe(false);
    expect(isBlockedIpv4("10.1.2.3")).toBe(true);
    expect(isBlockedIpv4("127.0.0.1")).toBe(true);
    expect(isBlockedIpv4("169.254.169.254")).toBe(true);
    expect(isBlockedIpv4("100.64.0.1")).toBe(true);
  });
  it("blocks loopback, link-local, metadata and intranet names", () => {
    for (const u of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/",
      "http://intranet/",
      "http://foo.local/",
      "ftp://example.com/",
      "https://user:pw@example.com/",
      "https://example.com:6379/",
    ]) {
      expect(checkSsrf(u).safe, u).toBe(false);
    }
  });
});
