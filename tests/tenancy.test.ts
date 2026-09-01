import { describe, expect, it, vi } from "vitest";
import {
  EdgeHostnameLeakError,
  SiteLookupError,
  SiteResolver,
  absoluteUrl,
  assertNoEdgeHostname,
  contentUrl,
  isEdgeHost,
  isWithinPrefix,
  normaliseHost,
  normalisePathPrefix,
  normaliseTrailingSlash,
  resolvePublicHost,
  toInternalPath,
  toPublicPath,
  type SiteRoute,
} from "@/lib/tenancy";

const site: SiteRoute = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  orgId: "11111111-1111-1111-1111-111111111111",
  canonicalDomain: "acme.com",
  pathPrefix: "/resources",
  edgeHostname: "acme-8fj2.blogedge.aeo.app",
  proxyMode: "cloudflare_worker",
  trailingSlash: "never",
  locale: "en-US",
  status: "active",
  allowedHosts: ["acme.com", "www.acme.com"],
};

describe("host normalisation", () => {
  it("lowercases, strips port and trailing dot", () => {
    expect(normaliseHost("ACME.com:443")).toBe("acme.com");
    expect(normaliseHost("acme.com.")).toBe("acme.com");
  });

  it("recognises our edge hosts but not lookalikes", () => {
    expect(isEdgeHost("acme-8fj2.blogedge.aeo.app")).toBe(true);
    expect(isEdgeHost("acme.com")).toBe(false);
    // A domain merely *ending* in the string must not match — only a real
    // subdomain of the zone does.
    expect(isEdgeHost("evilblogedge.aeo.app")).toBe(false);
  });
});

describe("path prefix", () => {
  it("normalises to leading slash, no trailing slash", () => {
    expect(normalisePathPrefix("resources/")).toBe("/resources");
    expect(normalisePathPrefix("//blog//")).toBe("/blog");
  });

  it("refuses to own the customer's whole domain", () => {
    expect(() => normalisePathPrefix("/")).toThrow();
  });

  it("matches the subtree without matching sibling prefixes", () => {
    expect(isWithinPrefix("/resources", "/resources")).toBe(true);
    expect(isWithinPrefix("/resources/a", "/resources")).toBe(true);
    // The bug this guards: /resources-archive must NOT resolve as ours.
    expect(isWithinPrefix("/resources-archive", "/resources")).toBe(false);
    expect(isWithinPrefix("/other", "/resources")).toBe(false);
  });
});

describe("internal path mapping", () => {
  it("round-trips, keeping the public prefix in the public url", () => {
    const internal = toInternalPath(site.id, "/resources/hello");
    expect(internal).toBe(`/render/${site.id}/resources/hello`);
    expect(toPublicPath(site.id, internal)).toBe("/resources/hello");
  });
});

describe("trailing slash", () => {
  it("strips in 'never' mode", () => {
    expect(normaliseTrailingSlash("/resources/a/", "never", "/resources")).toBe("/resources/a");
  });

  it("appends in 'always' mode", () => {
    expect(normaliseTrailingSlash("/resources/a", "always", "/resources")).toBe("/resources/a/");
  });

  it("returns null when already correct", () => {
    expect(normaliseTrailingSlash("/resources/a", "never", "/resources")).toBeNull();
  });

  it("exempts the prefix root in both modes, to avoid a redirect loop", () => {
    expect(normaliseTrailingSlash("/resources", "always", "/resources")).toBeNull();
    expect(normaliseTrailingSlash("/resources/", "never", "/resources")).toBeNull();
  });
});

describe("link discipline", () => {
  it("builds absolute urls on the verified public host", () => {
    const r = resolvePublicHost(site, "www.acme.com");
    expect(absoluteUrl(r, "/resources/x")).toBe("https://www.acme.com/resources/x");
  });

  it("never emits an absolute url on our edge hostname", () => {
    expect(() =>
      absoluteUrl({ canonicalDomain: site.edgeHostname, indexable: false }, "/x"),
    ).toThrow(EdgeHostnameLeakError);
  });

  it("respects trailing-slash mode when building content urls", () => {
    const r = resolvePublicHost(site, "acme.com");
    expect(contentUrl(r, site, "hello")).toBe("https://acme.com/resources/hello");
    expect(contentUrl(r, { ...site, trailingSlash: "always" }, "hello")).toBe(
      "https://acme.com/resources/hello/",
    );
  });

  it("detects a leaked edge hostname anywhere in rendered output", () => {
    expect(() =>
      assertNoEdgeHostname('<link rel="canonical" href="https://acme-8fj2.blogedge.aeo.app/x">'),
    ).toThrow(EdgeHostnameLeakError);
    expect(() => assertNoEdgeHostname("<h1>fine</h1>")).not.toThrow();
  });
});

describe("public host resolution", () => {
  it("trusts a registered forwarded host and marks it indexable", () => {
    expect(resolvePublicHost(site, "www.acme.com")).toEqual({
      canonicalDomain: "www.acme.com",
      indexable: true,
    });
  });

  it("refuses to index an unregistered forwarded host", () => {
    // An attacker setting x-forwarded-host must not be able to make us assert
    // a canonical on a domain the customer does not own.
    const r = resolvePublicHost(site, "evil.example");
    expect(r.indexable).toBe(false);
    expect(r.canonicalDomain).toBe("acme.com");
    expect(r.reason).toBe("unknown-forwarded-host");
  });

  it("refuses to index a direct hit on the edge host", () => {
    const r = resolvePublicHost(site, null);
    expect(r.indexable).toBe(false);
    expect(r.reason).toBe("no-forwarded-host");
  });

  it("refuses to index a site that is not active", () => {
    const r = resolvePublicHost({ ...site, status: "paused" }, "acme.com");
    expect(r.indexable).toBe(false);
    expect(r.reason).toBe("site-not-active");
  });
});

describe("SiteResolver caching", () => {
  const store = (impl: (h: string) => SiteRoute | null) => ({
    byEdgeHostname: vi.fn(async (h: string) => impl(h)),
  });

  it("caches hits and serves them from memory", async () => {
    const s = store((h) => (h === site.edgeHostname ? site : null));
    const r = new SiteResolver(s);
    await r.resolve(site.edgeHostname);
    await r.resolve(site.edgeHostname.toUpperCase());
    expect(s.byEdgeHostname).toHaveBeenCalledTimes(1);
  });

  it("caches misses too, so an unknown-host flood cannot hammer the db", async () => {
    const s = store(() => null);
    const r = new SiteResolver(s);
    await r.resolve("nope.blogedge.aeo.app");
    await r.resolve("nope.blogedge.aeo.app");
    expect(s.byEdgeHostname).toHaveBeenCalledTimes(1);
  });

  it("expires negative entries sooner than positive ones", async () => {
    let now = 0;
    const s = store(() => null);
    const r = new SiteResolver(s, 60_000, () => now);
    await r.resolve("nope.blogedge.aeo.app");
    now = 11_000; // past the 10s negative ttl, well inside the 60s positive ttl
    await r.resolve("nope.blogedge.aeo.app");
    expect(s.byEdgeHostname).toHaveBeenCalledTimes(2);
  });

  it("returns null for a missing host header rather than throwing", async () => {
    const r = new SiteResolver(store(() => site));
    expect(await r.resolve(null)).toBeNull();
  });
});

describe("lookup failure is not a miss", () => {
  it("propagates SiteLookupError rather than reporting 'not ours'", async () => {
    // Answering "unknown host" on a transport blip would make a Worker refetch
    // the customer's origin, serving THEIR 404 for an article that exists.
    const store = {
      byEdgeHostname: async () => {
        throw new SiteLookupError("boom");
      },
    };
    await expect(new SiteResolver(store).resolve("acme-8fj2.blogedge.aeo.app")).rejects.toBeInstanceOf(
      SiteLookupError,
    );
  });

  it("never caches a failed lookup", async () => {
    let calls = 0;
    const store = {
      byEdgeHostname: async () => {
        calls++;
        throw new SiteLookupError("boom");
      },
    };
    const r = new SiteResolver(store);
    await r.resolve("x.blogedge.aeo.app").catch(() => {});
    await r.resolve("x.blogedge.aeo.app").catch(() => {});
    expect(calls).toBe(2);
  });
});
