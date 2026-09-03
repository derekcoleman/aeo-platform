import type { PublicHostResolution, SiteRoute } from "@/lib/tenancy";
import { absoluteUrl, contentUrl } from "@/lib/tenancy";

/**
 * JSON-LD is built from structured data. An LLM never writes it.
 *
 * Schema is a machine contract: a model that invents a property name or emits
 * a plausible-looking date produces markup that validates as nothing and is
 * silently ignored by exactly the consumers we care about. Every field here
 * comes from a column.
 */

export interface ArticleSource {
  url: string;
  publisher?: string | null;
  title?: string | null;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface ArticleAuthor {
  name: string;
  url?: string | null;
  jobTitle?: string | null;
  sameAs?: string[];
}

export interface ArticleJsonLdInput {
  site: SiteRoute;
  host: PublicHostResolution;
  slug: string;
  title: string;
  description?: string | null;
  datePublished?: string | null;
  dateModified?: string | null;
  author?: ArticleAuthor | null;
  organizationName: string;
  organizationUrl?: string | null;
  organizationLogo?: string | null;
  image?: string | null;
  /** Entities the piece is about, with `sameAs` links where we have them. */
  about?: { name: string; sameAs?: string[] }[];
  /** External sources actually cited in the body. */
  citations?: ArticleSource[];
  faq?: FaqEntry[];
}

type JsonLdNode = Record<string, unknown>;

export function buildArticleJsonLd(input: ArticleJsonLdInput): JsonLdNode {
  const url = contentUrl(input.host, input.site, input.slug);

  const organization: JsonLdNode = {
    "@type": "Organization",
    name: input.organizationName,
    ...(input.organizationUrl ? { url: input.organizationUrl } : {}),
    ...(input.organizationLogo
      ? { logo: { "@type": "ImageObject", url: input.organizationLogo } }
      : {}),
  };

  const article: JsonLdNode = {
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: input.title,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    inLanguage: input.site.locale,
    publisher: organization,
  };

  if (input.description) article.description = input.description;
  if (input.datePublished) article.datePublished = input.datePublished;
  // dateModified matters disproportionately for answer engines, so fall back to
  // the publish date rather than omitting it.
  article.dateModified = input.dateModified ?? input.datePublished ?? undefined;
  if (input.image) article.image = input.image;

  if (input.author) {
    // A real named person with credentials, not "Admin" or the brand name.
    article.author = {
      "@type": "Person",
      name: input.author.name,
      ...(input.author.url ? { url: input.author.url } : {}),
      ...(input.author.jobTitle ? { jobTitle: input.author.jobTitle } : {}),
      ...(input.author.sameAs?.length ? { sameAs: input.author.sameAs } : {}),
    };
  }

  if (input.about?.length) {
    article.about = input.about.map((e) => ({
      "@type": "Thing",
      name: e.name,
      ...(e.sameAs?.length ? { sameAs: e.sameAs } : {}),
    }));
  }

  if (input.citations?.length) {
    article.citation = input.citations.map((c) => ({
      "@type": "CreativeWork",
      url: c.url,
      ...(c.title ? { name: c.title } : {}),
      ...(c.publisher ? { publisher: { "@type": "Organization", name: c.publisher } } : {}),
    }));
  }

  const graph: JsonLdNode[] = [article];

  // FAQPage is emitted only when the FAQ block is actually rendered on the
  // page. Marking up questions that a reader cannot see is a policy violation,
  // not a shortcut.
  if (input.faq?.length) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      mainEntity: input.faq.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }

  graph.push({
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumbs`,
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: input.organizationName,
        item: absoluteUrl(input.host, "/"),
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Resources",
        item: absoluteUrl(input.host, input.site.pathPrefix),
      },
      { "@type": "ListItem", position: 3, name: input.title, item: url },
    ],
  });

  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * Structural validation before the markup ships. Cheap, deterministic, and it
 * catches the failure mode that matters: markup that looks fine and means
 * nothing.
 */
export function validateArticleJsonLd(doc: JsonLdNode): string[] {
  const issues: string[] = [];
  const graph = doc["@graph"];
  if (!Array.isArray(graph) || graph.length === 0) {
    return ["@graph missing or empty"];
  }

  const article = graph.find((n) => (n as JsonLdNode)["@type"] === "BlogPosting") as
    | JsonLdNode
    | undefined;
  if (!article) return ["no BlogPosting node"];

  for (const field of ["headline", "url", "publisher", "mainEntityOfPage"]) {
    if (!article[field]) issues.push(`BlogPosting.${field} missing`);
  }
  if (!article.datePublished) issues.push("BlogPosting.datePublished missing");
  if (!article.author) issues.push("BlogPosting.author missing (E-E-A-T)");

  const headline = article.headline;
  if (typeof headline === "string" && headline.length > 110) {
    issues.push("BlogPosting.headline exceeds 110 chars");
  }

  for (const node of graph as JsonLdNode[]) {
    if (node["@type"] === "FAQPage" && !Array.isArray(node.mainEntity)) {
      issues.push("FAQPage.mainEntity must be an array");
    }
  }
  return issues;
}
