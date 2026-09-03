import { describe, expect, it } from "vitest";
import { renderArticleDocument, renderArticleMarkdown } from "@/lib/render/document";
import { EdgeHostnameLeakError, assertNoEdgeHostname, type PublicHostResolution } from "@/lib/tenancy";
import type { PublishedPage } from "@/lib/render/published";
import type { SiteRenderConfig } from "@/lib/render/site-config";

const config: SiteRenderConfig = {
  siteId: "site-1",
  canonicalDomain: "acme.com",
  pathPrefix: "/resources",
  locale: "en-US",
  trailingSlash: "never",
  theme: {
    tokens: { link: "#0055ff" },
    headerHtml: '<header><a href="/">Acme</a></header>',
    footerHtml: "<footer>© Acme</footer>",
  },
  organization: { name: "Acme", url: "https://acme.com" },
};

const host: PublicHostResolution = { canonicalDomain: "acme.com", indexable: true };

const page: PublishedPage = {
  siteId: "site-1",
  path: "/resources/sso-vs-scim",
  contentItemId: "c1",
  html: "<p>Answer first.</p>",
  head: {
    title: "SSO vs SCIM",
    description: "What the difference actually is.",
    datePublished: "2026-08-01T00:00:00.000Z",
    dateModified: "2026-08-20T00:00:00.000Z",
    author: { name: "Dana Reed", url: "https://acme.com/team/dana" },
    jsonLd: { "@context": "https://schema.org", "@graph": [{ "@type": "BlogPosting" }] },
  },
  markdown: "# SSO vs SCIM\n\nAnswer first.",
  etag: "abc",
  updatedAt: new Date("2026-08-20T00:00:00.000Z"),
};

const input = { config, host, page, slug: "sso-vs-scim" };

describe("article document", () => {
  it("ships no client JavaScript", () => {
    const html = renderArticleDocument(input);
    // The entire premise: AI crawlers fetch raw HTML without executing JS, and
    // the page must survive a blocked CDN or a strict CSP.
    expect(html).not.toMatch(/<script(?![^>]*type="application\/ld\+json")/);
    expect(html).not.toContain("/_next/");
  });

  it("inlines theme css rather than linking a stylesheet", () => {
    const html = renderArticleDocument(input);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).toContain("--aeo-link:#0055ff");
  });

  it("emits a canonical on the verified public host", () => {
    expect(renderArticleDocument(input)).toContain(
      '<link rel="canonical" href="https://acme.com/resources/sso-vs-scim">',
    );
  });

  it("never contains our edge hostname", () => {
    expect(() => assertNoEdgeHostname(renderArticleDocument(input))).not.toThrow();
  });

  it("marks noindex when the public host could not be verified", () => {
    const html = renderArticleDocument({
      ...input,
      host: { canonicalDomain: "acme.com", indexable: false },
    });
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  it("honours a page-level noindex even on a verified host", () => {
    const html = renderArticleDocument({
      ...input,
      page: { ...page, head: { ...page.head, noindex: true } },
    });
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it("advertises the markdown variant", () => {
    expect(renderArticleDocument(input)).toContain(
      '<link rel="alternate" type="text/markdown" href="https://acme.com/resources/sso-vs-scim.md">',
    );
  });

  it("renders a named byline and a visible updated date (E-E-A-T)", () => {
    const html = renderArticleDocument(input);
    expect(html).toContain("Dana Reed");
    expect(html).toContain("Updated <time datetime=\"2026-08-20T00:00:00.000Z\">2026-08-20</time>");
  });

  it("owns the h1 and puts the byline under it, not above", () => {
    const html = renderArticleDocument(input);
    expect(html).toContain("<h1>SSO vs SCIM</h1><p class=\"aeo-meta\">");
    // Exactly one h1: the body must not carry its own.
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
  });

  it("escapes the title rather than trusting it", () => {
    const html = renderArticleDocument({
      ...input,
      page: { ...page, head: { ...page.head, title: 'x" onload="alert(1)' } },
    });
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("strips script tags out of theme fragments", () => {
    // Fragments are scraped from the customer's own site and injected on their
    // origin — a script here would run same-origin with their app.
    const html = renderArticleDocument({
      ...input,
      config: {
        ...config,
        theme: { ...config.theme, headerHtml: '<header><script>alert(1)</script>hi</header>' },
      },
    });
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("hi");
  });

  it("escapes JSON-LD so it cannot break out of the script block", () => {
    const html = renderArticleDocument({
      ...input,
      page: { ...page, head: { ...page.head, jsonLd: { evil: "</script><img onerror=x>" } } },
    });
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script");
  });
});

describe("markdown variant", () => {
  it("carries front matter with the canonical url", () => {
    const md = renderArticleMarkdown(input);
    expect(md).toContain("url: https://acme.com/resources/sso-vs-scim");
    expect(md).toContain('title: "SSO vs SCIM"');
    expect(md).toContain("# SSO vs SCIM");
  });
});

describe("edge hostname invariant", () => {
  it("catches a leak introduced through page html", () => {
    expect(() =>
      assertNoEdgeHostname(
        renderArticleDocument({
          ...input,
          page: { ...page, html: '<a href="https://acme-8fj2.blogedge.aeo.app/x">x</a>' },
        }),
      ),
    ).toThrow(EdgeHostnameLeakError);
  });
});
