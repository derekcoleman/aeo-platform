import { describe, expect, it } from "vitest";
import { composeQaDocument, composeVersion, qaDocumentFor } from "@/lib/pipeline/compose";
import { mechanicsGate, runQaGates, safeSourceFetcher, scopeGate, scopeKey, sectionHeadings, sentenceLengthCv, slopGate, structureGate, structureMinFrom, unmarkedStatistics, verifySources, verifySourcesWith } from "@/lib/pipeline/qa";
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
    expect(report.gates.map((g) => [g.gate, g.passed])).toEqual([["structure", true], ["sources", true], ["grounding", true], ["mechanics", true], ["slop", true], ["safety", true]]);
    expect(report.passed).toBe(true);
    expect(report.requiresHuman).toBe(false);
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

describe("structure on the composed document", () => {
  const organization = { name: "Acme", url: "https://acme.com" };
  const c = composeVersion({ draft, brief, site, organization, author, slug: "sso-vs-scim", datePublished: NOW });
  const documentHtml = composeQaDocument(c, site, organization, "sso-vs-scim");
  const input = { ...qaInput(), documentHtml, canonicalUrl: c.page.canonicalUrl };

  it("is the renderer's document: head, JSON-LD, one H1, the byline and dates", () => {
    expect(documentHtml).toContain(`<link rel="canonical" href="https://acme.com/resources/sso-vs-scim">`);
    expect(documentHtml).toContain('<script type="application/ld+json">');
    expect(documentHtml.match(/<h1[ >]/g)).toHaveLength(1);
    expect(documentHtml).toContain(`rel="author"`);
    expect(documentHtml).toContain(`<meta property="article:published_time" content="${NOW.toISOString()}">`);
    expect(documentHtml).toContain(c.bodyHtml);
    expect(documentHtml).not.toContain(site.edgeHostname);
  });

  it("clears the production floor, and scores what the body-only wrapper could not see", () => {
    const floor = structureMinFrom({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(floor).toBe(65);
    const full = structureGate(input, floor);
    const bare = structureGate(qaInput(), floor);
    expect(full.passed).toBe(true);
    expect(full.structure.normalized).toBeGreaterThanOrEqual(floor);
    expect(full.structure.normalized).toBeGreaterThan(bare.structure.normalized);
    const score = (r: typeof full, key: string) => r.structure.findings.find((f) => f.key === key)!.score;
    for (const key of ["schema_valid", "freshness", "author_eeat"]) expect(score(full, key)).toBeGreaterThan(score(bare, key));
    // The byline is not mistaken for the answer under the H1.
    expect(score(full, "answer_block")).toBe(score(bare, "answer_block"));
  });

  it("passes the full report at the production floor", async () => {
    const fetchImpl = fakeFetch({ [gartnerSource.url]: `<p>${gartnerSource.quote}.</p>` });
    const report = await runQaGates(input, { fetchImpl });
    expect(report.passed).toBe(true);
  });

  it("scores a cms item as a body: only its body HTML goes to the CMS, none of our document", () => {
    expect(qaDocumentFor(c, "pipeline", site, organization, "sso-vs-scim")).toEqual({ documentHtml, canonicalUrl: c.page.canonicalUrl });
    const cms = qaDocumentFor(c, "cms", site, organization, "sso-vs-scim");
    expect(cms).toEqual({});
    const floor = structureMinFrom({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(structureGate({ ...qaInput(), ...cms }, floor).structure.normalized).toBe(structureGate(qaInput(), floor).structure.normalized);
  });
});

describe("safeSourceFetcher", () => {
  /** No DNS in tests: skip resolution. The literal-address check on every hop still runs. */
  async function offline<T>(fn: () => Promise<T>): Promise<T> {
    const prior = process.env.AEO_FETCH_ALLOW_PRIVATE;
    process.env.AEO_FETCH_ALLOW_PRIVATE = "1";
    try {
      return await fn();
    } finally {
      if (prior === undefined) delete process.env.AEO_FETCH_ALLOW_PRIVATE;
      else process.env.AEO_FETCH_ALLOW_PRIVATE = prior;
    }
  }

  it("refuses a cited URL that points at the metadata address, without fetching it, and records why", async () => {
    let called = 0;
    const counting = (async () => {
      called++;
      return new Response("secret");
    }) as typeof fetch;
    const [v] = await verifySourcesWith([{ ...gartnerSource, url: "http://169.254.169.254/latest/meta-data/" }], safeSourceFetcher(counting));
    expect(v).toMatchObject({ verified: false, status: null });
    expect(v!.reason).toMatch(/^fetch failed: host 169\.254\.169\.254 is not publicly routable/);
    expect(called).toBe(0);
  });

  it("checks every redirect hop", async () => {
    const hops = (async (url: string | URL | Request) =>
      String(url).startsWith("https://example.org/")
        ? new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } })
        : new Response("internal")) as typeof fetch;
    const [v] = await offline(() => verifySourcesWith([gartnerSource], safeSourceFetcher(hops)));
    expect(v).toMatchObject({ verified: false, status: null });
    expect(v!.reason).toMatch(/^fetch failed: host 127\.0\.0\.1 is not publicly routable/);
  });

  it("verifies a public source through the same path", async () => {
    const ok = (async () => new Response(`<p>${gartnerSource.quote}.</p>`, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    const [v] = await offline(() => verifySourcesWith([gartnerSource], safeSourceFetcher(ok)));
    expect(v).toMatchObject({ verified: true, status: 200 });
  });

  it("holds one deadline over the body too: a source that sends headers and then stalls fails at the timeout", async () => {
    // Headers and the first bytes arrive at once; the rest never does.
    const stalled = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`<p>${gartnerSource.quote}`));
          },
        }),
        { status: 200, headers: { "content-type": "text/html" } },
      )) as typeof fetch;
    const started = Date.now();
    const [v] = await offline(() => verifySourcesWith([gartnerSource], safeSourceFetcher(stalled), 200));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(v).toMatchObject({ verified: false, status: null });
    expect(v!.reason).toMatch(/^fetch failed: .*(aborted|timeout)/i);
  });
});

describe("mechanicsGate / slopGate", () => {
  it("catches placeholders, empty links, missing alt, an H1 and edge-host leaks", () => {
    const r = mechanicsGate({ title: "T", bodyMd: "Body [TODO] here", bodyHtml: '<h1>x</h1><a href="#">link</a><img src="/a.png"><p>acme-8fj2.blogedge.aeo.app</p>', sources: [], intent: "unknown" });
    expect(r.passed).toBe(false);
    expect(r.detail.problems).toHaveLength(5);
  });

  it("fails a body that prints its FAQ section twice (a refresh that kept the live FAQ and answered it again)", async () => {
    const once = compose();
    expect(mechanicsGate({ ...qaInput(), bodyHtml: once.bodyHtml }).passed).toBe(true);
    const kept = once.bodyMd.slice(once.bodyMd.indexOf("## Frequently asked questions"));
    const twice = qaInput(`${draft.bodyMd}\n\n${kept}`);
    const r = mechanicsGate(twice);
    expect(r.passed).toBe(false);
    expect(r.detail.problems).toEqual([expect.stringMatching(/FAQ section appears 2 times; return FAQ entries only in the faq array/)]);
    const fetchImpl = fakeFetch({ [gartnerSource.url]: `<p>${gartnerSource.quote}.</p>` });
    const report = await runQaGates(twice, { fetchImpl, structureMin: 0 });
    expect(report.passed).toBe(false);
    expect(report.routeTo).toBe("draft");
    expect(report.feedback).toEqual(expect.arrayContaining([expect.stringMatching(/^Mechanics: the FAQ section appears 2 times/)]));
  });

  it("without FAQ evidence neither scores nor asks for an FAQ, and fails one written into the body", async () => {
    const noFaq = (body = draft.bodyMd) => {
      const c = composeVersion({ draft: { ...draft, bodyMd: body, faq: [] }, brief, site, organization: { name: "Acme" }, author, slug: "sso-vs-scim", datePublished: NOW });
      return { title: draft.title, bodyMd: c.bodyMd, bodyHtml: c.bodyHtml, sources: brief.sources, facts: [scimFact], intent: brief.intent, jsonLd: c.page.jsonLd, now: NOW };
    };
    // With an FAQ expected, a draft without one loses faq_block's points and is told to add one.
    const expected = await runQaGates(noFaq(), { structureMin: 101 });
    expect(expected.structure.findings.find((f) => f.key === "faq_block")).toMatchObject({ passed: false, notApplicable: false });
    expect(expected.feedback).toEqual(expect.arrayContaining([expect.stringMatching(/^\[faq_block\] Add an FAQ section/)]));
    // Without evidence: not scored, never asked for.
    const report = await runQaGates({ ...noFaq(), allowFaq: false }, { structureMin: 101 });
    expect(report.structure.findings.find((f) => f.key === "faq_block")).toMatchObject({ notApplicable: true, recommendation: undefined });
    expect(report.feedback.some((f) => /faq/i.test(f))).toBe(false);
    expect(report.structure.maxScore).toBe(expected.structure.maxScore - 6);
    // An FAQ the model writes into the body anyway goes back.
    const bodyFaq = `${draft.bodyMd}\n\n## Frequently asked questions\n\n### Is SCIM required?\n\nNo.\n\n### Does SCIM need SSO?\n\nUsually.\n\n### Is SCIM free?\n\nIt depends.`;
    const r = mechanicsGate({ ...noFaq(bodyFaq), allowFaq: false });
    expect(r.detail.problems).toEqual([expect.stringMatching(/^the body has an FAQ section, but this article has none/)]);
    expect(mechanicsGate(noFaq(bodyFaq)).passed).toBe(true);
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

describe("scope gate (a figures-and-dates update)", () => {
  // The live page as loadExistingContent hands it over: markers out, FAQ split off.
  const live = { title: "SSO vs SCIM in 2025: what mid-market security teams need", bodyMd: draft.bodyMd.replace(/\{\{(?:src|fact):[^}]+\}\}/g, "").replace("62%", "58%") };
  const updated = (body = draft.bodyMd, title = "SSO vs SCIM in 2026: what mid-market security teams need") => ({ ...qaInput(body), title, keep: live });

  it("is off unless the work is a figures-and-dates update", () => {
    expect(scopeGate(qaInput())).toBeNull();
  });

  it("passes a draft that kept the title, the headings in order and the length, numbers aside", () => {
    expect(sectionHeadings(compose().bodyMd)).toEqual(["What does SSO actually do?", "What does SCIM add on top of SSO?", "Which should a mid-market team implement first?"]);
    expect(scopeKey("What changed in **2026**? See [the report](https://x.test/r)")).toBe("what changed in # see the report");
    expect(scopeGate(updated())).toMatchObject({ gate: "scope", passed: true, detail: { problems: [] } });
  });

  it("sends back a rewrite with the headings it must keep", async () => {
    const body = draft.bodyMd.replace("## Which should a mid-market team implement first?", "## A brand new section\n\nWith new text.\n\n## Which should a mid-market team implement first?");
    const gate = scopeGate(updated(body, "SCIM: the definitive guide"))!;
    expect(gate.passed).toBe(false);
    expect(gate.detail.problems).toEqual([
      'the title changed: keep "SSO vs SCIM in 2025: what mid-market security teams need"',
      "the headings changed: keep every heading of the live page, in its order, and add none",
    ]);
    const report = await runQaGates(updated(body, "SCIM: the definitive guide"), { structureMin: 0 });
    expect(report.gates.map((g) => g.gate)).toContain("scope");
    expect(report.passed).toBe(false);
    expect(report.routeTo).toBe("draft");
    expect(report.feedback[0]).toMatch(/^This is a figures-and-dates update of a live page that is winning, not a rewrite: the title changed/);
    expect(report.feedback[1]).toBe('Keep these headings, in this order: "What does SSO actually do?", "What does SCIM add on top of SSO?", "Which should a mid-market team implement first?".');
  });

  it("holds the length within a quarter, and only the headings it saw when the live body was cut short", () => {
    const padded = `${draft.bodyMd}\n\n${"More words that were not there before. ".repeat(40)}`;
    expect(scopeGate(updated(padded))!.detail.problems).toEqual([expect.stringMatching(/^the length changed from \d+ to \d+ words/)]);
    const cut = { ...updated(padded), keep: { ...live, bodyMd: live.bodyMd.split("## Which should")[0]!, truncated: true } };
    expect(scopeGate(cut)).toMatchObject({ passed: true });
  });
});
