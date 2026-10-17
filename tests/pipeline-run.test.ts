import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardOutcome } from "@/lib/pipeline/coverage";
import type { OpportunityRow } from "@/lib/pipeline/opportunities";
import type { ExistingContent } from "@/lib/refresh/publish";
import { fakeSql } from "./helpers/fake-sql";
import { brief, draft, ORG_ID, site, SITE_ID } from "./fixtures/pipeline";

/**
 * The content pipeline's handler, run end to end against stand-ins for every
 * step body, to pin the wiring between steps that the unit tests of each
 * piece cannot see: which object the run carries on with after the coverage
 * guard, and when the draft gate opens under auto-publish.
 */

const m = vi.hoisted(() => ({
  sql: null as unknown,
  loadOpportunity: vi.fn(),
  markOpportunity: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
  loadApprovalPolicy: vi.fn(async () => "auto_publish"),
  loadSiteRoute: vi.fn(),
  loadSiteOrganization: vi.fn(async () => ({ name: "Acme" })),
  defaultAuthor: vi.fn(async () => null),
  coverageGuard: vi.fn(),
  loadBriefContext: vi.fn<(opp: unknown) => Promise<object>>(async () => ({})),
  generateBrief: vi.fn(),
  insertBrief: vi.fn(async () => ({ id: "brief-1" })),
  setBriefStatus: vi.fn(async () => undefined),
  assertArticleBudget: vi.fn(async () => undefined),
  loadContentItem: vi.fn(async () => null),
  importCmsItem: vi.fn<(id: string, ...rest: unknown[]) => Promise<{ id: string; slug: string; imported: boolean }>>(async () => ({ id: "item-cms", slug: "scim-guide", imported: true })),
  createContentItem: vi.fn(async () => ({ id: "item-new" })),
  reserveSlug: vi.fn(async (_site: string, slug: string) => slug),
  loadExistingContent: vi.fn<(opp: unknown) => Promise<ExistingContent | null>>(async () => null),
  generateDraft: vi.fn(),
  runQaGates: vi.fn(),
  insertVersion: vi.fn(async () => ({ id: "version-1", versionNo: 1 })),
  noop: vi.fn(async () => undefined),
  humanGate: vi.fn<(...args: unknown[]) => Promise<null>>(async () => null),
  holdWhilePaused: vi.fn(async () => ({ held: "stopped by the test" })),
}));

vi.mock("@/lib/db/app", () => ({ appDb: () => m.sql }));
vi.mock("@/lib/connectors", async (orig) => ({ ...(await orig<object>()), connectorContext: () => ({}) }));
vi.mock("@/lib/pipeline/opportunities", async (orig) => ({ ...(await orig<object>()), loadOpportunity: m.loadOpportunity, markOpportunity: m.markOpportunity, markFailed: m.markFailed }));
vi.mock("@/lib/pipeline/approvals", async (orig) => ({ ...(await orig<object>()), loadApprovalPolicy: m.loadApprovalPolicy }));
vi.mock("@/lib/pipeline/publish", async (orig) => ({ ...(await orig<object>()), loadSiteRoute: m.loadSiteRoute, loadSiteOrganization: m.loadSiteOrganization }));
vi.mock("@/lib/pipeline/coverage", async (orig) => ({ ...(await orig<object>()), coverageGuard: m.coverageGuard }));
vi.mock("@/lib/pipeline/briefs", async (orig) => ({ ...(await orig<object>()), loadBriefContext: m.loadBriefContext, generateBrief: m.generateBrief, insertBrief: m.insertBrief, setBriefStatus: m.setBriefStatus }));
vi.mock("@/lib/pipeline/model", async (orig) => ({ ...(await orig<object>()), assertArticleBudget: m.assertArticleBudget }));
vi.mock("@/lib/pipeline/draft", async (orig) => ({ ...(await orig<object>()), generateDraft: m.generateDraft }));
vi.mock("@/lib/pipeline/compose", async (orig) => ({
  ...(await orig<object>()),
  composeVersion: () => ({ bodyMd: draft.bodyMd, bodyHtml: "<p>body</p>", faq: [], page: { jsonLd: {} }, cited: [], wordCount: 300 }),
  qaDocumentFor: () => ({}),
}));
vi.mock("@/lib/pipeline/qa", async (orig) => ({ ...(await orig<object>()), runQaGates: m.runQaGates }));
vi.mock("@/lib/pipeline/gate", async (orig) => ({ ...(await orig<object>()), humanGate: m.humanGate }));
vi.mock("@/lib/pipeline/guard", async (orig) => ({ ...(await orig<object>()), holdWhilePaused: m.holdWhilePaused }));
vi.mock("@/lib/refresh/publish", async (orig) => ({ ...(await orig<object>()), importCmsItem: m.importCmsItem, loadExistingContent: m.loadExistingContent }));
vi.mock("@/lib/pipeline/versions", async (orig) => ({
  ...(await orig<object>()),
  defaultAuthor: m.defaultAuthor,
  loadContentItem: m.loadContentItem,
  createContentItem: m.createContentItem,
  reserveSlug: m.reserveSlug,
  insertVersion: m.insertVersion,
  insertSources: m.noop,
  insertContentFacts: m.noop,
  insertQaResults: m.noop,
}));

const { contentPipelineFunction } = await import("@/lib/inngest/pipeline");
type Handler = (ctx: { event: { data: Record<string, unknown> }; step: unknown; attempt: number; runId: string }) => Promise<Record<string, unknown>>;
const handler = (contentPipelineFunction as unknown as { fn: Handler }).fn;

const OPP_ID = "0pp00000-0000-4000-8000-000000000001";
const CMS = "c0000000-0000-4000-8000-000000000001";

const opportunity = (over: Partial<OpportunityRow> = {}): OpportunityRow => ({
  id: OPP_ID, org_id: ORG_ID, site_id: SITE_ID, source: "citation_gap", status: "open", action_type: "new_page",
  title: "what is scim provisioning", target_query: "what is scim provisioning", question_id: null, content_item_id: null, topic_id: null, format: null, score: 12, evidence: { snapshotId: "s1" }, ...over,
});

const report = (safety: { kind: string; where: string; match: string }[] = []) => ({
  passed: true, gates: [], routeTo: null, feedback: [], requiresHuman: safety.length > 0, structure: { normalized: 80 }, verifications: [], citedFacts: [], safety,
});

const live: ExistingContent = { title: "The SCIM guide", url: "https://acme.com/blog/scim", description: "All about SCIM.", bodyMd: "Intro.\n\n## What is SCIM?\n\nIt syncs accounts.", faq: [], wordCount: 8, lastUpdated: "2026-03-01", reasons: [] };

/** Inngest's `step`, as the handler sees it: `run` executes and round-trips through JSON, as memoisation does. */
function fakeStep() {
  const log: string[] = [];
  const step = {
    async run(id: string, fn: () => unknown) {
      log.push(id);
      const v = await fn();
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    async sendEvent(id: string) {
      log.push(id);
      return { ids: ["evt"] };
    },
    async sleepUntil(id: string) {
      log.push(id);
    },
    async sleep(id: string) {
      log.push(id);
    },
  };
  return { step, log };
}

const run = (step: unknown) => handler({ event: { data: { opportunityId: OPP_ID, siteId: SITE_ID, orgId: ORG_ID } }, step, attempt: 0, runId: "run-1" });
const gateLabels = () => m.humanGate.mock.calls.map((c) => c[1] as string);
const gateFacts = (label: string) => (m.humanGate.mock.calls.find((c) => c[1] === label)![2] as { notice: { facts: { label: string; value: string }[] } }).notice.facts;

beforeEach(() => {
  vi.clearAllMocks();
  m.sql = fakeSql();
  m.loadOpportunity.mockResolvedValue(opportunity());
  m.loadSiteRoute.mockResolvedValue(site);
  m.generateBrief.mockResolvedValue({ spec: brief, run: {} });
  m.generateDraft.mockResolvedValue({ draft, run: {} });
  m.runQaGates.mockResolvedValue(report());
  m.coverageGuard.mockResolvedValue({ proceed: true, actionType: "new_page", contentItemId: null, evidence: { snapshotId: "s1" }, brandFit: null, checked: true } satisfies GuardOutcome);
});

describe("the content pipeline's handler", () => {
  it("under auto-publish goes straight to publishing a clean draft", async () => {
    const { step } = fakeStep();
    expect(await run(step)).toMatchObject({ ok: false, stage: "publish", error: "publishing paused: stopped by the test" });
    expect(m.humanGate).not.toHaveBeenCalled();
  });

  it("opens the draft gate for a draft with a safety finding, even under auto-publish", async () => {
    m.runQaGates.mockResolvedValue(report([{ kind: "email", where: "body", match: "dana@acme.com" }]));
    const { step } = fakeStep();
    expect(await run(step)).toMatchObject({ ok: false, stage: "draft_gate" });
    expect(gateLabels()).toEqual(["draft-gate:1"]);
    expect(gateFacts("draft-gate:1")).toContainEqual({ label: "Safety check", value: 'review before publishing: an email address: "dana@acme.com"' });
  });

  it("carries on from the guard's answer: the page it found is the one imported, drafted from and reviewed", async () => {
    m.coverageGuard.mockResolvedValue({
      proceed: true, actionType: "refresh", contentItemId: null, brandFit: null, checked: true,
      evidence: { snapshotId: "s1", cmsItemId: CMS, coverage: { kind: "serp_owned", url: "https://acme.com/blog/scim", title: "The SCIM guide" } },
    } satisfies GuardOutcome);
    m.loadExistingContent.mockResolvedValue(live);
    const { step } = fakeStep();
    expect(await run(step)).toMatchObject({ ok: false, stage: "draft_gate" });
    // The opportunity the run loaded was a new page; everything after the guard sees the refresh.
    expect(m.loadBriefContext.mock.calls[0]![0]).toMatchObject({ id: OPP_ID, action_type: "refresh", evidence: { cmsItemId: CMS } });
    expect(m.importCmsItem).toHaveBeenCalledWith(CMS, expect.anything(), expect.anything());
    expect(m.createContentItem).not.toHaveBeenCalled();
    expect(m.loadExistingContent.mock.calls[0]![0]).toMatchObject({ content_item_id: "item-cms", evidence: { cmsItemId: CMS } });
    expect(m.generateDraft.mock.calls[0]![1]).toMatchObject({ refresh: { url: live.url, actionType: "refresh" }, previous: { title: live.title } });
    // Rewriting a page nobody asked to rewrite is a person's call, whatever the policy.
    expect(gateLabels()).toEqual(["draft-gate:1"]);
    expect(gateFacts("draft-gate:1")).toContainEqual({ label: "Replaces", value: "https://acme.com/blog/scim: the site already answers this question there, so this rewrites that page in place" });
  });

  it("holds a figures-and-dates update to the live page in QA", async () => {
    m.coverageGuard.mockResolvedValue({
      proceed: true, actionType: "update_stats", contentItemId: null, brandFit: null, checked: true,
      evidence: { cmsItemId: CMS, protectedWinner: true, coverage: { url: "https://acme.com/blog/scim" } },
    } satisfies GuardOutcome);
    m.loadExistingContent.mockResolvedValue(live);
    const { step } = fakeStep();
    await run(step);
    expect(m.runQaGates.mock.calls[0]![0]).toMatchObject({ keep: { title: live.title, bodyMd: live.bodyMd, truncated: false } });
    expect(m.generateDraft.mock.calls[0]![1]).toMatchObject({ refresh: { actionType: "update_stats" } });
  });

  it("stops where the guard dismissed the work, before any model is paid", async () => {
    m.coverageGuard.mockResolvedValue({ proceed: false, dismissReason: "auto_coverage", reason: "Not written: covered" } satisfies GuardOutcome);
    const { step, log } = fakeStep();
    expect(await run(step)).toEqual({ ok: false, skipped: "Not written: covered", dismissed: "auto_coverage" });
    expect(m.generateBrief).not.toHaveBeenCalled();
    expect(log.at(-1)).toBe("coverage-guard");
  });
});
