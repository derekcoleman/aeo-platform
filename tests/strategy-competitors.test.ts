import { describe, expect, it } from "vitest";
import { demandCounts } from "@/lib/app/demand";
import { groupByRole, namedCompetitors, sourcesShapingAnswers, type SourceDomainRow } from "@/lib/app/strategy";
import { NON_TARGET_SOURCE_ROLES } from "@/lib/measure/source-roles";
import { loadInventorySignals } from "@/lib/refresh/scan";
import { analyzeHtml, classifyContentType, collectCompetitorUrls, structuralTargetBlock, structuralTargetFrom, type CompetitorPageRow } from "@/lib/strategy/competitors";
import { parseHtml } from "@/lib/audit/html";
import { fakeSql } from "./helpers/fake-sql";

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

describe("classifyContentType", () => {
  const sig = (title: string, html: string) => {
    const $ = parseHtml(html);
    const headings = $("h2, h3").map((_, el) => $(el).text()).get();
    return classifyContentType({ title, headings, markdown: $("body").text(), $ });
  };
  it("recognises comparisons, how-tos, lists, FAQs, news and product pages", () => {
    expect(sig("Okta vs Entra ID: which SSO is better?", page("x", "<table><tr><td>a</td></tr></table>"))).toBe("comparison");
    expect(sig("How to set up SCIM provisioning", page("x", "<ol><li>1</li><li>2</li><li>3</li></ol>"))).toBe("howto");
    expect(sig("12 best identity providers in 2026", page("x", "<p>list</p>"))).toBe("listicle");
    expect(sig("SCIM FAQ", page("x", ""))).toBe("faq");
    expect(sig("Acme announces SCIM support", page("x", ""))).toBe("news");
    expect(sig("Identity platform", page("x", "<p>Start free. Book a demo. Sign up today for pricing.</p>"))).toBe("product");
    expect(sig("Guide", page("x", `<p>${"word ".repeat(400)}</p>`))).toBe("guide");
  });
});

describe("analyzeHtml", () => {
  it("returns headings, word count, a structure score and a classification", () => {
    const html = page("What is SCIM provisioning?", "<p>SCIM automates account lifecycle across apps in one standard.</p><h2>What does SCIM do?</h2><p>It provisions and deprovisions users.</p><h2>How is it different from SSO?</h2><p>SSO authenticates; SCIM provisions.</p>");
    const a = analyzeHtml("https://okta.com/scim", html);
    expect(a.domain).toBe("okta.com");
    expect(a.title).toContain("SCIM");
    expect(a.headings).toHaveLength(2);
    expect(a.wordCount).toBeGreaterThan(15);
    expect(a.structure?.findings.length).toBeGreaterThan(5);
    expect(["guide", "faq", "unknown"]).toContain(a.contentType);
  });
});

describe("structuralTargetFrom", () => {
  const row = (o: Partial<CompetitorPageRow>): CompetitorPageRow => ({
    id: "x", topic_id: null, url: "https://a.com/p", domain: "a.com", title: null, content_type: "guide", word_count: 1000, structure_score: null, headings: ["What is it?", "Setup"], citations_30d: 1, last_cited_at: null, fetch_error: null, fetched_at: null, ...o,
  });
  it("summarises the dominant format, medians and feature shares, skipping failed fetches", () => {
    const rows = [
      row({ content_type: "comparison", word_count: 1500, structure_score: { score: 50, maxScore: 100, normalized: 50, findings: [{ key: "comparison_table", title: "", passed: true, score: 1, maxScore: 1, evidence: {} }] } }),
      row({ url: "https://b.com/p", content_type: "comparison", word_count: 900 }),
      row({ url: "https://c.com/p", content_type: "guide", word_count: 2200, headings: ["Why?", "How?"] }),
      row({ url: "https://d.com/p", fetch_error: "status 403", word_count: 0 }),
    ];
    const t = structuralTargetFrom(rows);
    expect(t.pages).toBe(3);
    expect(t.dominantType).toBe("comparison");
    expect(t.medianWords).toBe(1500);
    expect(t.tablePct).toBe(33);
    expect(t.questionHeadingPct).toBeGreaterThan(50);
    expect(structuralTargetBlock(t)).toContain("dominant format comparison");
    expect(structuralTargetBlock(structuralTargetFrom([]))).toBe("");
  });
});

describe("native-only competitor reads", () => {
  const SITE = "aaaaaaaa-0000-0000-0000-000000000001";

  it("the cited-page set comes from Google AI Overview citations of our own trackers, never Profound's engines", async () => {
    const sql = fakeSql();
    await collectCompetitorUrls(SITE, {}, sql);
    expect(sql.queries[0]!.text).toContain("join measure.v_native_aio s on s.id = c.serp_snapshot_id");
    expect(sql.queries[0]!.text).toContain("c.surface = 'ai_overview' and c.source_role <> all ($2::measure.source_role[])");
  });

  it("forums, video, social, review sites, wikis, directories and marketplaces are never a structural target; publishers, vendors and unknown domains are", async () => {
    const sql = fakeSql();
    await collectCompetitorUrls(SITE, {}, sql);
    const excluded = sql.queries[0]!.values[1] as string[];
    expect(excluded).toEqual(["owned", "ugc_forum", "video", "professional_social", "review_platform", "reference_wiki", "directory", "partner_marketplace"]);
    expect(excluded).toEqual([...NON_TARGET_SOURCE_ROLES]);
    for (const kept of ["competitor", "publisher_editorial", "analyst", "vendor_other", "unknown"]) expect(excluded).not.toContain(kept);
  });

  it("named competitors and sources shaping answers are native by default; Profound is asked for on its own, every surface counted", async () => {
    const sql = fakeSql();
    await namedCompetitors(SITE, {}, sql);
    await namedCompetitors(SITE, { source: "profound" }, sql);
    await sourcesShapingAnswers(SITE, {}, sql);
    await sourcesShapingAnswers(SITE, { source: "profound" }, sql);
    const [named, namedProfound, sources, sourcesProfound] = sql.queries;
    expect(named!.text).toContain("join measure.v_native_aio s on s.id = c.serp_snapshot_id");
    expect(named!.text).toContain("c.source_role = 'competitor' and c.entity_id is not null and (c.surface = 'ai_overview' or s.provider = 'profound')");
    // Every competitor the org named is listed, cited or not, and only this site's org's.
    expect(named!.text).toContain("from context.entities e join app.sites st on st.id = $4 and st.org_id = e.org_id left join cited ci on ci.entity_id = e.id where e.type = 'competitor'");
    expect(namedProfound!.text).toContain("join (select * from measure.v_answer_observations where provider = 'profound') s on s.id = c.serp_snapshot_id");
    expect(sources!.text).toContain("join measure.v_native_aio s on s.id = c.serp_snapshot_id");
    expect(sources!.text).toContain("not c.is_owned and c.source_role not in ('owned', 'competitor') and (c.surface = 'ai_overview' or s.provider = 'profound')");
    expect(sourcesProfound!.text).toContain("join (select * from measure.v_answer_observations where provider = 'profound') s on s.id = c.serp_snapshot_id");
    // Never an answer probe: neither relation holds one.
    for (const q of [named, namedProfound, sources, sourcesProfound]) expect(q!.text).not.toContain("measure.serp_snapshots");
  });

  it("sources group by role, the most cited role first and the unclassified last", () => {
    const row = (role: SourceDomainRow["role"], domain: string, citations: number): SourceDomainRow => ({ role, domain, citations, questions: 1, providers: ["serpapi"], overridden: false });
    const groups = groupByRole([row("unknown", "rival.example", 30), row("ugc_forum", "reddit.com", 12), row("review_platform", "g2.com", 9), row("ugc_forum", "quora.com", 8)]);
    expect(groups.map((g) => [g.role, g.label, g.citations, g.domains.map((d) => d.domain)])).toEqual([
      ["ugc_forum", "Forums and communities", 20, ["reddit.com", "quora.com"]],
      ["review_platform", "Review sites", 9, ["g2.com"]],
      ["unknown", "Not classified yet", 30, ["rival.example"]],
    ]);
  });

  it("the Demand page's 7-day snapshot count is native only", async () => {
    const sql = fakeSql();
    await demandCounts(SITE, sql);
    expect(sql.queries[0]!.text).toContain("(select count(*)::int from measure.v_native_aio s where s.site_id = $1 and s.fetched_at >= now() - interval '7 days') as snapshots_7d");
  });

  it("the refresh scan counts native AI Overview citations only, and Profound's on any surface", async () => {
    const sql = fakeSql();
    await loadInventorySignals(SITE, sql);
    const text = sql.queries.find((q) => q.text.startsWith("with gsc as"))!.text;
    expect(text).toContain("select id, question_id, fetched_at, 'native' as source from measure.v_native_aio");
    expect(text).toContain("select id, question_id, fetched_at, 'profound' from measure.v_answer_observations where site_id = $3 and provider = 'profound'");
    expect(text).toContain("filter (where s.source = 'native' and c.surface = 'ai_overview' and s.fetched_at >= now() - interval '30 days') as native,");
    expect(text).toContain("filter (where s.source = 'profound' and s.fetched_at >= now() - interval '30 days') as profound,");
  });
});
