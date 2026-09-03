import { describe, expect, it } from "vitest";
import { composeVersion } from "@/lib/pipeline/compose";
import { mechanicsGate, runQaGates, sentenceLengthCv, slopGate, unmarkedStatistics, verifySources } from "@/lib/pipeline/qa";
import { author, brief, draft, gartnerSource, scimFact, site } from "./fixtures/pipeline";

const NOW = new Date("2026-09-01T12:00:00Z");

function compose(body = draft.bodyMd) {
  return composeVersion({ draft: { ...draft, bodyMd: body }, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: NOW });
}

function qaInput(body = draft.bodyMd, sources = brief.sources) {
  const c = compose(body);
  return { title: draft.title, bodyMd: c.bodyMd, bodyHtml: c.bodyHtml, sources, facts: [scimFact], intent: brief.intent, jsonLd: c.page.jsonLd, now: NOW };
}

function fakeFetch(pages: Record<string, string | number>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = String(url);
    const page = pages[key];
    if (page === undefined) return new Response("nope", { status: 404 });
    if (typeof page === "number") return new Response("", { status: page });
    return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

describe("unmarkedStatistics", () => {
  it("flags a numeric claim in a paragraph with no marker", () => {
    const hits = unmarkedStatistics("Intro.\n\nWe grew revenue 40% last year. Nothing else.\n\n## Heading with 50%\n\n| 90% | table |");
    expect(hits).toEqual([{ paragraph: 1, sentence: "We grew revenue 40% last year." }]);
  });

  it("accepts a numeric claim whose paragraph carries a marker; ignores bare years", () => {
    expect(unmarkedStatistics("In 2026, 62% of buyers require SCIM {{src:gartner-2026}}.")).toEqual([]);
    expect(unmarkedStatistics("Founded in 2019, the company grew.")).toEqual([]);
  });
});

describe("verifySources", () => {
  it("passes when the verbatim quote is on the page, fails otherwise", async () => {
    const fetchImpl = fakeFetch({
      [gartnerSource.url]: `<html><body><script>var x = "62% of mid-market buyers require SCIM provisioning before purchase"</script><p>Our survey found that <b>62%</b> of mid‑market buyers require SCIM provisioning before purchase.</p></body></html>`,
      "https://example.org/missing": "<p>Different text entirely.</p>",
      "https://example.org/down": 503,
    });
    const out = await verifySources(
      [gartnerSource, { ...gartnerSource, key: "missing", url: "https://example.org/missing" }, { ...gartnerSource, key: "down", url: "https://example.org/down" }],
      fetchImpl,
    );
    expect(out[0]).toMatchObject({ key: "gartner-2026", verified: false });
    expect(out[1]).toMatchObject({ key: "missing", verified: false, reason: "quote not found at url" });
    expect(out[2]).toMatchObject({ key: "down", verified: false, status: 503 });
  });

  it("matches across curly quotes, dashes and whitespace but not inside scripts", async () => {
    const fetchImpl = fakeFetch({ [gartnerSource.url]: "<p>Our survey found that 62% of mid-market buyers\n require   SCIM provisioning before purchase.</p>" });
    const [v] = await verifySources([gartnerSource], fetchImpl);
    expect(v).toMatchObject({ verified: true, status: 200 });
  });
});

describe("runQaGates", () => {
  it("passes a grounded draft whose only statistic is cited and verifiable", async () => {
    const fetchImpl = fakeFetch({ [gartnerSource.url]: `<p>${gartnerSource.quote}.</p>` });
    const report = await runQaGates(qaInput(), { fetchImpl, structureMin: 0 });
    expect(report.gates.map((g) => [g.gate, g.passed])).toEqual([["structure", true], ["sources", true], ["grounding", true], ["mechanics", true], ["slop", true]]);
    expect(report.passed).toBe(true);
    expect(report.routeTo).toBeNull();
    expect(report.verifications).toEqual([expect.objectContaining({ key: "gartner-2026", verified: true })]);
    expect(report.structure.normalized).toBeGreaterThan(0);
  });

  it("rejects a fabricated statistic and routes back to the draft", async () => {
    const body = draft.bodyMd.replace("Implement SSO first,", "Teams that do this cut admin time by 73%. Implement SSO first,");
    const report = await runQaGates(qaInput(body), { structureMin: 0 });
    expect(report.passed).toBe(false);
    expect(report.routeTo).toBe("draft");
    expect(report.feedback.some((f) => f.includes("cut admin time by 73%"))).toBe(true);
  });

  it("routes to the brief when the draft has numbers and the brief supplied nothing to cite", async () => {
    const body = draft.bodyMd.replace(" {{src:gartner-2026}}", "");
    const report = await runQaGates(qaInput(body, []), { structureMin: 0 });
    expect(report.passed).toBe(false);
    expect(report.routeTo).toBe("brief");
  });

  it("rejects an unresolved marker and a failed live verification", async () => {
    const body = draft.bodyMd.replace("Every plan does {{fact:product-capability-supports-eeee}}.", "Every plan does {{src:nope}}.");
    const fetchImpl = fakeFetch({ [gartnerSource.url]: "<p>The quote is not here.</p>" });
    const report = await runQaGates(qaInput(body), { fetchImpl, structureMin: 0 });
    const sources = report.gates.find((g) => g.gate === "sources")!;
    expect(sources.passed).toBe(false);
    expect(sources.detail.unresolved).toEqual(["nope"]);
    expect(report.feedback).toEqual(expect.arrayContaining([expect.stringContaining("{{src:nope}}"), expect.stringContaining("could not be verified")]));
  });

  it("enforces the structure floor", async () => {
    const report = await runQaGates(qaInput(), { structureMin: 101 });
    expect(report.gates[0]).toMatchObject({ gate: "structure", passed: false });
    expect(report.feedback[0]).toMatch(/Structure score \d+ is below 101/);
  });
});

describe("mechanicsGate / slopGate", () => {
  it("catches placeholders, empty links, missing alt, an H1 and edge-host leaks", () => {
    const r = mechanicsGate({ title: "T", bodyMd: "Body [TODO] here", bodyHtml: '<h1>x</h1><a href="#">link</a><img src="/a.png"><p>acme-8fj2.blogedge.aeo.app</p>', sources: [], intent: "unknown" });
    expect(r.passed).toBe(false);
    expect(r.detail.problems).toHaveLength(5);
  });

  it("flags banned phrases and uniform sentence length", () => {
    const uniform = Array.from({ length: 12 }, () => "This sentence has exactly seven words total.").join(" ");
    const r = slopGate({ title: "T", bodyMd: "", bodyHtml: `<p>Let's delve into it. ${uniform}</p>`, sources: [], intent: "unknown" });
    expect(r.passed).toBe(false);
    expect(r.detail.bannedPhrases).toEqual(["delve into"]);
    expect(r.detail.uniform).toBe(true);
  });

  it("sentenceLengthCv measures variation", () => {
    expect(sentenceLengthCv("One two three. One two three.").cv).toBe(0);
    expect(sentenceLengthCv("Short one here. This one is a good deal longer than the first one was.").cv).toBeGreaterThan(0.4);
  });
});
