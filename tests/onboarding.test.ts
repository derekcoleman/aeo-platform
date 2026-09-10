import { describe, expect, it } from "vitest";
import { classifyPath, crawlSite, prioritizeForProfile } from "@/lib/crawl/site";
import { pagesToDocuments } from "@/lib/connectors/website";
import { businessProfileSchema, keywordsToTopics, parseKeywords, profilePrompt } from "@/lib/onboarding/profile";
import { fakeSql } from "./helpers/fake-sql";

const SITE = "https://acme.example";
const page = (title: string, body: string, links: string[] = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><nav>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</nav><main>${body}</main></body></html>`;

const pages: Record<string, string> = {
  "/": page("Acme — IAM for mid-market", "<h1>Acme</h1><p>Identity management for mid-market SaaS. SCIM provisioning, SSO, audit logs.</p>".repeat(3), ["/about", "/pricing", "/product/scim", "/blog", "/privacy", "/logo.png", "/about#team"]),
  "/about": page("About Acme", "<p>Founded 2019 in Austin. We serve 400 customers including Initech.</p>".repeat(3)),
  "/pricing": page("Pricing", "<p>Starter $99/mo, Growth $499/mo, Enterprise custom.</p>".repeat(3)),
  "/product/scim": page("SCIM provisioning", "<p>Automated user provisioning to 200 apps.</p>".repeat(3)),
  "/blog": page("Blog", "<p>Posts.</p>".repeat(3)),
  "/privacy": page("Privacy", "<p>Legal text.</p>".repeat(3)),
  "/robots.txt": "User-agent: *\nAllow: /\n",
};

const fetchImpl = (async (url: string | URL | Request) => {
  const u = new URL(String(url));
  if (u.hostname !== "acme.example") throw new TypeError("fetch failed");
  const body = pages[u.pathname];
  if (body === undefined) return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
  const ct = u.pathname.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8";
  return new Response(body, { status: 200, headers: { "content-type": ct } });
}) as typeof fetch;

describe("classifyPath / prioritizeForProfile", () => {
  it("classifies the pages that describe a business", () => {
    expect(classifyPath("/")).toBe("home");
    expect(classifyPath("/about/team")).toBe("about");
    expect(classifyPath("/pricing")).toBe("pricing");
    expect(classifyPath("/product/scim")).toBe("product");
    expect(classifyPath("/compare/okta")).toBe("compare");
    expect(classifyPath("/okta-vs-entra")).toBe("compare");
    expect(classifyPath("/blog/scim-vs-sso")).toBe("blog");
    expect(classifyPath("/privacy")).toBe("legal");
    expect(classifyPath("/random")).toBe("other");
  });

  it("orders by informativeness, drops assets, fragments, legal and foreign origins, and dedupes", () => {
    const out = prioritizeForProfile(
      [`${SITE}/blog/x`, `${SITE}/about#team`, `${SITE}/about`, `${SITE}/pricing?ref=1`, `${SITE}/logo.png`, `${SITE}/privacy`, "https://other.example/about", `${SITE}/product/scim`],
      10,
      SITE,
    );
    expect(out).toEqual([`${SITE}/about`, `${SITE}/pricing`, `${SITE}/product/scim`, `${SITE}/blog/x`]);
  });
});

describe("crawlSite", () => {
  it("fetches the homepage, then the most relevant linked pages, as markdown", async () => {
    const { origin, pages: got } = await crawlSite(SITE, { maxPages: 4, fetch: { fetchImpl, allowPrivate: true } });
    expect(origin).toBe(SITE);
    expect(got[0]?.kind).toBe("home");
    expect(got.map((p) => p.path)).toEqual(["/", "/about", "/pricing", "/product/scim"]);
    expect(got[2]?.markdown).toContain("Starter $99/mo");
    expect(got[1]?.title).toBe("About Acme");
  });

  it("rejects non-HTML and unreachable roots with a coded error", async () => {
    await expect(crawlSite("https://down.example", { fetch: { fetchImpl, allowPrivate: true } })).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("pagesToDocuments / profilePrompt", () => {
  it("maps crawled pages to context documents keyed by URL", async () => {
    const { pages: got } = await crawlSite(SITE, { maxPages: 2, fetch: { fetchImpl, allowPrivate: true } });
    const docs = pagesToDocuments(got, "site-1");
    expect(docs[0]).toMatchObject({ kind: "web_page", externalId: `${SITE}/`, siteId: "site-1", metadata: { pageKind: "home", path: "/" } });
  });

  it("puts home, about and pricing first and respects the budget", async () => {
    const { pages: got } = await crawlSite(SITE, { maxPages: 4, fetch: { fetchImpl, allowPrivate: true } });
    const prompt = profilePrompt([...got].reverse(), { domain: "acme.example", name: "Acme" }, 2000);
    expect(prompt.indexOf("### home")).toBeLessThan(prompt.indexOf("### about"));
    expect(prompt.length).toBeLessThan(2200);
  });
});

describe("parseKeywords / keywordsToTopics", () => {
  it("splits, trims, dedupes case-insensitively and bounds", () => {
    expect(parseKeywords("scim provisioning\nSSO, sso ,  x ,okta alternatives;")).toEqual(["scim provisioning", "SSO", "okta alternatives"]);
    expect(parseKeywords(null)).toEqual([]);
  });

  it("creates a topic per new keyword and skips ones already tracked by name or seed", async () => {
    const sql = fakeSql([
      [/from measure\.topics where site_id/, () => [{ id: "t1", name: "SCIM provisioning", seed_terms: ["scim"], status: "active" }]],
      [/select slug from measure\.topics/, () => []],
      [/insert into measure\.topics/, (q) => [{ id: "new", name: q.values[1], slug: q.values[2], seed_terms: [] }]],
    ]);
    const r = await keywordsToTopics("site-1", ["scim", "SSO for mid-market", "scim provisioning"], sql);
    expect(r.created).toEqual(["SSO for mid-market"]);
    expect(r.skipped).toEqual(["scim", "scim provisioning"]);
    expect(sql.queries.filter((q) => q.text.includes("insert into measure.topics"))).toHaveLength(1);
  });

  it("businessProfileSchema fills blanks with defaults and never rejects long or odd model output", () => {
    const p = businessProfileSchema.parse({ name: "Acme", oneLiner: "IAM for mid-market", category: "Identity", keywords: ["scim", "sso", "provisioning"] });
    expect(p.products).toEqual([]);
    expect(p.pricingModel).toBeNull();
    expect(p.keywords).toEqual(["scim", "sso", "provisioning"]);

    const long = businessProfileSchema.parse({
      name: "Acme",
      oneLiner: "x",
      category: "y",
      pricingModel: "Per seat, ".repeat(100),
      keywords: ["a", "SCIM", "scim", 42, " sso ", "k".repeat(200)],
      products: [{ name: "One", description: "d".repeat(500) }, "Two", { description: "no name" }, null],
      competitors: "Okta",
      differentiators: null,
    });
    expect(long.pricingModel).toHaveLength(400);
    expect(long.keywords).toEqual(["SCIM", "42", "sso", "k".repeat(80)]);
    expect(long.products).toEqual([{ name: "One", description: "d".repeat(300) }, { name: "Two", description: "" }]);
    expect(long.competitors).toEqual([]);
    expect(long.differentiators).toEqual([]);

    expect(() => businessProfileSchema.parse({ name: "", oneLiner: "x", category: "y" })).toThrow();
    expect(() => businessProfileSchema.parse({ oneLiner: "x", category: "y" })).toThrow();
  });
});
