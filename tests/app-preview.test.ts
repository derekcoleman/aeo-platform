import { describe, expect, it } from "vitest";
import { normaliseTheme, previewSiteHtml } from "@/lib/app/preview";
import { fakeSql } from "./helpers/fake-sql";

const SITE = "aaaaaaaa-0000-0000-0000-000000000001";

function sqlWithSite(theme: unknown = { tokens: { accent: "#0055ff" } }) {
  return fakeSql([
    [/from content\.site_render_config/, () => [{ site_id: SITE, canonical_domain: "acme.com", path_prefix: "/resources", locale: "en-US", trailing_slash: "never", theme, organization: { name: "Acme" } }]],
    [/from app\.sites s where s\.id/, () => [{ id: SITE, org_id: "o1", canonical_domain: "acme.com", path_prefix: "/resources", edge_hostname: "acme-8fj2.blogedge.aeo.app", proxy_mode: "cloudflare_worker", trailing_slash: "never", locale: "en-US", status: "active", site_domains: [{ hostname: "acme.com" }] }]],
  ]);
}

describe("previewSiteHtml", () => {
  it("renders the sample article in the site's theme when nothing is published, never indexable, never the edge host", async () => {
    const html = await previewSiteHtml(SITE, {}, sqlWithSite());
    expect(html).toBeTruthy();
    expect(html).toContain("SSO vs SCIM");
    expect(html).toContain("#0055ff");
    expect(html).toContain("noindex");
    expect(html).not.toContain("blogedge");
    expect(html).toContain("https://acme.com/resources/");
  });
  it("applies a draft theme override after sanitising it", async () => {
    const html = await previewSiteHtml(SITE, { themeOverride: { tokens: { accent: "#ff0000", "bad key!": "x" }, headerHtml: "<nav>Menu<script>alert(1)</script></nav>", footerHtml: null, customCss: "@import url(x); .a{color:red}" } }, sqlWithSite());
    expect(html).toContain("#ff0000");
    expect(html).toContain("Menu");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("@import");
  });
  it("returns null without a render config", async () => {
    expect(await previewSiteHtml(SITE, {}, fakeSql())).toBeNull();
  });
});

describe("normaliseTheme", () => {
  it("drops non-string tokens and malformed keys, sanitises fragments and css", () => {
    const t = normaliseTheme({ tokens: { accent: " #123 ", "Bad": "x", nope: 3 as unknown as string }, headerHtml: "<a href=\"javascript:x()\">x</a>", footerHtml: "", customCss: "expression(1) .b{}" });
    expect(t.tokens).toEqual({ accent: "#123" });
    expect(t.headerHtml).not.toContain("javascript:");
    expect(t.footerHtml).toBeNull();
    expect(t.customCss).not.toContain("expression(");
  });
});
