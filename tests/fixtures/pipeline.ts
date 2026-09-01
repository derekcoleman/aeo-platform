import type { SiteRoute } from "@/lib/tenancy/types";
import type { BriefSpec, DraftOutput, SourceSpec } from "@/lib/pipeline/types";
import type { AuthorRow } from "@/lib/pipeline/versions";

/** Shared pipeline fixtures: the Acme lighthouse site, one verifiable source, a brief and a draft that cites it. */

export const ORG_ID = "11111111-1111-1111-1111-111111111111";
export const SITE_ID = "aaaaaaaa-0000-0000-0000-000000000001";

export const site: SiteRoute = {
  id: SITE_ID,
  orgId: ORG_ID,
  canonicalDomain: "acme.com",
  pathPrefix: "/resources",
  edgeHostname: "acme-8fj2.blogedge.aeo.app",
  proxyMode: "cloudflare_worker",
  trailingSlash: "never",
  locale: "en-US",
  status: "active",
  allowedHosts: ["acme.com", "www.acme.com"],
};

export const author: AuthorRow = { id: "cccccccc-0000-0000-0000-000000000001", name: "Dana Reyes", job_title: "Head of Security", url: "https://acme.com/team/dana", same_as: ["https://www.linkedin.com/in/danareyes"] };

export const gartnerSource: SourceSpec = {
  key: "gartner-2026",
  url: "https://example.org/reports/identity-2026",
  publisher: "Gartner",
  title: "Identity and Access Management 2026",
  quote: "62% of mid-market buyers require SCIM provisioning before purchase",
};

export const brief: BriefSpec = {
  headQuestion: "What is the difference between SSO and SCIM?",
  targetAnswer:
    "SSO lets a person sign in to many applications with one identity, while SCIM automatically creates, updates and removes those user accounts across applications. SSO answers who can log in; SCIM keeps the list of accounts in sync with the directory, so offboarding actually removes access.",
  intent: "comparative",
  title: "SSO vs SCIM: what mid-market security teams need",
  description: "SSO and SCIM solve different halves of identity: one signs people in, the other keeps their accounts in sync. Here is how to choose and sequence them.",
  outline: [
    { heading: "What does SSO actually do?", goal: "Define SSO plainly", sourceKeys: [] },
    { heading: "What does SCIM add on top of SSO?", goal: "Define SCIM and provisioning", sourceKeys: ["gartner-2026"] },
    { heading: "Which should a mid-market team implement first?", goal: "Sequencing advice", sourceKeys: [] },
  ],
  faq: ["Does SCIM require SSO?", "Is SCIM the same as user provisioning?"],
  entities: ["SSO", "SCIM", "Okta", "Microsoft Entra"],
  internalLinks: [{ url: "https://acme.com/pricing", anchor: "Acme pricing" }],
  pov: "Acme ships SCIM on every plan, so provisioning is not an enterprise upsell.",
  bannedClaims: ["Acme is the only vendor with SCIM"],
  sources: [gartnerSource],
};

export const draft: DraftOutput = {
  title: "SSO vs SCIM: what mid-market security teams need",
  description: "SSO and SCIM solve different halves of identity: one signs people in, the other keeps their accounts in sync. Here is how to choose and sequence them.",
  bodyMd: [
    "SSO lets a person sign in to many applications with one identity, while SCIM automatically creates, updates and removes those user accounts across applications. SSO answers who can log in; SCIM keeps the list of accounts in sync with the directory, so offboarding actually removes access.",
    "## What does SSO actually do?",
    "Single sign-on (SSO) lets a user authenticate once, with an identity provider such as Okta or Microsoft Entra, and reach every connected application without a second password. It replaces per-app credentials with one federated login. The application trusts the identity provider's assertion instead of checking a password of its own.",
    "That is the whole job. SSO says nothing about whether the account should exist in the first place.",
    "## What does SCIM add on top of SSO?",
    "SCIM (System for Cross-domain Identity Management) is a provisioning protocol: the identity provider pushes account creates, updates and deactivations to each application automatically. When someone leaves, their account is removed everywhere within minutes. According to Gartner, 62% of mid-market buyers require SCIM provisioning before purchase {{src:gartner-2026}}.",
    "| Capability | SSO | SCIM |\n|---|---|---|\n| Sign in once | Yes | No |\n| Create accounts automatically | No | Yes |\n| Remove access on offboarding | No | Yes |",
    "## Which should a mid-market team implement first?",
    "Implement SSO first, because it removes password sprawl immediately and SCIM depends on the same identity provider connection. Add SCIM as soon as headcount changes outpace manual admin work. Most teams reach that point long before they expect to.",
    "See [Acme pricing](https://acme.com/pricing) for which plans include SCIM. Every plan does.",
  ].join("\n\n"),
  faq: [
    { question: "Does SCIM require SSO?", answer: "Not strictly, but in practice both run through the same identity provider, so teams almost always deploy SSO first and add SCIM afterwards." },
    { question: "Is SCIM the same as user provisioning?", answer: "SCIM is the standard protocol most identity providers use for user provisioning; provisioning is the outcome, SCIM is how it is done {{src:gartner-2026}}." },
  ],
};
