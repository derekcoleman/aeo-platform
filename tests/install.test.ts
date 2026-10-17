import { describe, expect, it } from "vitest";
import { CAPABILITIES, CURRENT_WORKER_VERSION, HMAC_SECRET_PLACEHOLDER, buildInstall, workerUpgradeNotice, type InstallContext } from "@/lib/proxy/install";
import type { ProxyMode } from "@/lib/tenancy";

const ctx = (mode: ProxyMode): InstallContext => ({
  site: {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    name: "Acme",
    canonicalDomain: "acme.com",
    pathPrefix: "/resources",
    edgeHostname: "acme-8fj2.blogedge.aeo.app",
    proxyMode: mode,
  },
  hmacSecret: "s3cret",
  mirrorOrigin: "https://mirror.aeo.app",
  crawlEndpoint: "https://api.aeo.app/api/ingest/crawl",
});

const MODES: ProxyMode[] = ["cloudflare_worker", "vercel_rewrite", "nginx", "netlify", "subdomain"];

describe("install generation", () => {
  it.each(MODES)("produces a config for %s", (mode) => {
    const out = buildInstall(ctx(mode));
    expect(out.config.length).toBeGreaterThan(0);
    expect(out.filename).toBeTruthy();
  });

  it("substitutes every placeholder in the worker template", () => {
    const out = buildInstall(ctx("cloudflare_worker"));
    // An unsubstituted {{TOKEN}} would ship a broken Worker to a customer.
    expect(out.config).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(out.config).toContain("acme-8fj2.blogedge.aeo.app");
    expect(out.config).toContain("aaaaaaaa-0000-0000-0000-000000000001");
    expect(out.config).toContain('cacheHost: "acme.com"');
    expect(out.routePattern).toBe("acme.com/resources/*");
  });

  it("tells a www-hosted site how to keep its edge cache", () => {
    // canonical_domain never carries www., but a customer may route the Worker on www.
    expect(buildInstall(ctx("cloudflare_worker")).routeNote).toMatch(/route the Worker there instead, set cacheHost in its CONFIG to www\.acme\.com/);
    expect(buildInstall(ctx("nginx")).routeNote).toBeUndefined();
  });

  it("generates the current Worker version", () => {
    expect(buildInstall(ctx("cloudflare_worker")).config).toContain(`workerVersion: "${CURRENT_WORKER_VERSION}"`);
  });

  it("embeds the signing secret for a manager and a placeholder for anyone else", () => {
    const manager = buildInstall(ctx("cloudflare_worker"));
    expect(manager.config).toContain('hmacSecret: "s3cret"');
    expect(manager.secretWithheld).toBe(false);
    const viewer = buildInstall({ ...ctx("cloudflare_worker"), hmacSecret: null });
    expect(viewer.config).not.toContain("s3cret");
    expect(viewer.config).toContain(`hmacSecret: "${HMAC_SECRET_PLACEHOLDER}"`);
    expect(viewer.secretWithheld).toBe(true);
    expect(buildInstall({ ...ctx("nginx"), hmacSecret: null }).secretWithheld).toBe(false);
  });

  it("points every mode at the site's own edge hostname and prefix", () => {
    for (const mode of ["cloudflare_worker", "vercel_rewrite", "nginx", "netlify"] as ProxyMode[]) {
      expect(buildInstall(ctx(mode)).config).toContain("acme-8fj2.blogedge.aeo.app");
    }
  });

  it("never asks the customer to proxy their root robots.txt", () => {
    // Blast radius of getting that wrong is their entire site.
    for (const mode of MODES) {
      const out = buildInstall(ctx(mode));
      expect(out.extraRewrites.map((r) => r.source)).not.toContain("/robots.txt");
      expect(out.config).not.toMatch(/^\s*\/robots\.txt/m);
    }
  });

  it("asks for the llms.txt rewrites, which are otherwise unused paths", () => {
    const sources = buildInstall(ctx("cloudflare_worker")).extraRewrites.map((r) => r.source);
    expect(sources).toEqual(["/llms.txt", "/llms-full.txt", "/.well-known/llms.txt"]);
  });
});

describe("mode capabilities are disclosed, not flattened", () => {
  it("only the worker mode is fully capable", () => {
    expect(CAPABILITIES.cloudflare_worker).toMatchObject({
      stripsCookies: true,
      passthroughOnCollision: true,
      fallbackOrigin: true,
      crawlCoverage: "full",
    });
  });

  it("warns loudly when a mode cannot strip cookies", () => {
    const out = buildInstall(ctx("vercel_rewrite"));
    expect(out.capabilities.stripsCookies).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/session cookies will reach our origin/i);
  });

  it("warns that partial crawl coverage is a floor, not a total", () => {
    const out = buildInstall(ctx("netlify"));
    expect(out.warnings.join(" ")).toMatch(/floor, not a total/i);
  });

  it("warns that a subdomain is weaker for AI search than a subfolder", () => {
    expect(buildInstall(ctx("subdomain")).warnings.join(" ")).toMatch(/weaker for AI search/i);
  });

  it("issues no capability warnings for the worker mode", () => {
    expect(buildInstall(ctx("cloudflare_worker")).warnings).toEqual([]);
  });
});

describe("generated nginx config", () => {
  it("blanks Cookie and Authorization", () => {
    const config = buildInstall(ctx("nginx")).config;
    expect(config).toContain('proxy_set_header   Cookie            "";');
    expect(config).toContain('proxy_set_header   Authorization     "";');
  });

  it("forwards the original host, without which every page is noindex", () => {
    expect(buildInstall(ctx("nginx")).config).toContain("X-Forwarded-Host  $host");
  });
});

describe("generated vercel config", () => {
  it("is valid json with the content prefix and the llms rewrites", () => {
    const parsed = JSON.parse(buildInstall(ctx("vercel_rewrite")).config) as {
      rewrites: { source: string; destination: string }[];
    };
    expect(parsed.rewrites[0]).toEqual({
      source: "/resources/:path*",
      destination: "https://acme-8fj2.blogedge.aeo.app/resources/:path*",
    });
    expect(parsed.rewrites).toHaveLength(4);
  });
});

describe("worker upgrade notice", () => {
  const site = { proxyMode: "cloudflare_worker" as ProxyMode, workerVersion: null as string | null, installed: true, canonicalDomain: "acme.com" };

  it("asks an installed site with no version report to check its Worker", () => {
    expect(workerUpgradeNotice(site)).toMatch(/not reported a version.*redeploy/i);
  });

  it("asks a site on an older Worker to redeploy", () => {
    expect(workerUpgradeNotice({ ...site, workerVersion: "1" })).toMatch(/reports version 1; the current version is 2/);
    expect(workerUpgradeNotice({ ...site, workerVersion: "bogus" })).toMatch(/reports version bogus/);
  });

  it("is quiet for a current Worker, a site not yet installed and the other modes", () => {
    expect(workerUpgradeNotice({ ...site, workerVersion: CURRENT_WORKER_VERSION })).toBeNull();
    expect(workerUpgradeNotice({ ...site, workerVersion: "3" })).toBeNull();
    expect(workerUpgradeNotice({ ...site, installed: false })).toBeNull();
    expect(workerUpgradeNotice({ ...site, proxyMode: "vercel_rewrite" })).toBeNull();
  });
});
