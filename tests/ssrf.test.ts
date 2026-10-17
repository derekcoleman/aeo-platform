import { describe, expect, it } from "vitest";
import { checkSsrf, isBlockedIpv4, isBlockedIpv6, parseIpv6 } from "@/lib/fetch/ssrf";

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

describe("IPv6 literals", () => {
  it("parses compression, brackets and a trailing dotted quad", () => {
    expect(parseIpv6("[::1]")).toEqual(Uint8Array.from([...Array(15).fill(0), 1]));
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual(parseIpv6("::ffff:7f00:1"));
    expect(parseIpv6("2606:4700:4700::1111")?.slice(0, 2)).toEqual(Uint8Array.from([0x26, 0x06]));
    for (const bad of ["1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "::ffff:999.0.0.1", "fe80::1%eth0", "12345::", ":1", "example.com"]) {
      expect(parseIpv6(bad), bad).toBeNull();
    }
  });

  it("blocks loopback, private and metadata addresses hidden inside IPv6", () => {
    // The URL parser serialises [::ffff:127.0.0.1] as [::ffff:7f00:1]; a
    // dotted-quad-only check let that through.
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    for (const u of [
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::127.0.0.1]/",
      "http://[::ffff:0:a9fe:a9fe]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:7f00:1::]/",
      "http://[2002:a00:1::]/",
      "http://[::]/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fec0::1]/",
      "http://[ff02::1]/",
      "http://[100::1]/",
      "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
      "http://[2001:db8::1]/",
      "http://[64:ff9b:1::1]/",
    ]) {
      expect(checkSsrf(u).safe, u).toBe(false);
    }
  });

  it("allows public addresses, including public IPv4 reached through IPv6", () => {
    expect(checkSsrf("http://[2606:4700:4700::1111]/").safe).toBe(true);
    expect(checkSsrf("http://[2a00:1450:4001:830::200e]/").safe).toBe(true);
    expect(checkSsrf("http://[::ffff:8.8.8.8]/").safe).toBe(true);
    expect(checkSsrf("http://[2002:808:808::1]/").safe).toBe(true);
  });

  it("judges resolved addresses the same way, and refuses what it cannot parse", () => {
    // What fetch.ts checks after DNS: the dotted form, never bracketed.
    expect(isBlockedIpv6("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:93.184.216.34")).toBe(false);
    expect(isBlockedIpv6("fe80::1%eth0")).toBe(true);
    expect(isBlockedIpv6("not-an-address")).toBe(true);
  });
});
