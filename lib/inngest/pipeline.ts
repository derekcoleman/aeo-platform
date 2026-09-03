import { connectorContext } from "@/lib/connectors";
import { appDb } from "@/lib/db/app";
import {
  createApproval,
  expireApproval,
  loadApproval,
  loadApprovalPolicy,
  notifyApprovalSlack,
  recordDecision,
  requiredGates,
  updateSlackDecision,
  type ApprovalKind,
  type ApprovalNotice,
} from "@/lib/pipeline/approvals";
import { loadFactStatuses } from "@/lib/context/facts";
import { loadManifest, manifestPromptBlock } from "@/lib/context/manifest";
import { generateBrief, insertBrief, loadBrief, loadBriefContext, setBriefStatus } from "@/lib/pipeline/briefs";
import { composeVersion } from "@/lib/pipeline/compose";
import { generateDraft, slugify } from "@/lib/pipeline/draft";
import { citationStatus, POST_PUBLISH_WINDOWS_DAYS, windowDate } from "@/lib/pipeline/loop";
import { modelFor } from "@/lib/pipeline/model";
import { loadOpportunity, markOpportunity, openRefreshOpportunity, scanSite } from "@/lib/pipeline/opportunities";
import { loadSiteOrganization, loadSiteRoute, publishVersion } from "@/lib/pipeline/publish";
import { runQaGates } from "@/lib/pipeline/qa";
import type { BriefSpec, DraftOutput } from "@/lib/pipeline/types";
import {
  createContentItem,
  defaultAuthor,
  insertContentFacts,
  insertQaResults,
  insertSources,
  insertVersion,
  loadContentItem,
  loadSources,
  loadVersion,
  reserveSlug,
} from "@/lib/pipeline/versions";
import {
  approvalDecided,
  approvalRequested,
  contentPipelineFailed,
  contentPipelineRequested,
  contentPublished,
  inngest,
  opportunitiesScanRequested,
  serpTrackRequested,
} from "./client";

/**
 * The content pipeline as one durable function: brief → (human gate) → draft
 * → QA → (human gate) → publish → +14/+30/+60d re-measure. Every LLM call and
 * every DB write sits in its own `step.run`, so a retry after a provider
 * blip re-pays nothing that completed, and the gates are `waitForEvent`s
 * that hold the run for days with its state intact.
 */

const MAX_BRIEF_VERSIONS = 3;
const MAX_QA_ATTEMPTS = 3;
const MAX_REVIEW_ROUNDS = 2;
const GATE_TIMEOUT = "7d";
const GATE_TTL_MS = 7 * 86_400_000;

type Step = Parameters<Parameters<typeof inngest.createFunction>[1]>[0]["step"];

interface GateResult {
  decision: "approve" | "changes" | "regenerate";
  note: string | null;
  by: string;
}

function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_URL ?? "https://app.aeo.app").replace(/\/$/, "");
}

/** Open an approval, tell Slack (best effort) and the app, then hold until a human decides or the gate expires. */
async function humanGate(
  step: Step,
  label: string,
  input: { kind: ApprovalKind; siteId: string; orgId: string; briefId?: string | null; contentVersionId?: string | null; notice: Omit<ApprovalNotice, "approvalId"> },
): Promise<GateResult | null> {
  const approvalId = await step.run(`${label}:open`, async () => {
    const { id } = await createApproval({
      siteId: input.siteId,
      kind: input.kind,
      briefId: input.briefId ?? null,
      contentVersionId: input.contentVersionId ?? null,
      expiresAt: new Date(Date.now() + GATE_TTL_MS),
    });
    try {
      await notifyApprovalSlack(input.orgId, { ...input.notice, approvalId: id }, connectorContext());
    } catch (e) {
      // Slack is a convenience path; the app UI always renders the gate.
      console.warn(`[pipeline] slack approval notice failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return id;
  });
  await step.sendEvent(`${label}:requested`, approvalRequested.create({ approvalId, kind: input.kind, siteId: input.siteId, orgId: input.orgId }));
  const evt = await step.waitForEvent(`${label}:wait`, { event: approvalDecided, if: `event.data.approvalId == "${approvalId}"`, timeout: GATE_TIMEOUT });
  if (!evt) {
    await step.run(`${label}:expire`, () => expireApproval(approvalId));
    return null;
  }
  return { decision: evt.data.decision, note: evt.data.note ?? null, by: evt.data.by.name ?? evt.data.by.userId ?? evt.data.source };
}

export const contentPipelineFunction = inngest.createFunction(
  {
    id: "content-pipeline",
    triggers: [contentPipelineRequested],
    concurrency: [{ key: "event.data.orgId", limit: 2 }, { limit: 10 }],
    retries: 2,
  },
  async ({ event, step, attempt }) => {
    const { opportunityId, siteId, orgId, note = null } = event.data;
    let stage: "brief" | "brief_gate" | "draft" | "qa" | "draft_gate" | "publish" = "brief";

    const fail = async (reason: string) => {
      await step.run(`fail:${stage}`, () => markOpportunity(opportunityId, "failed", appDb(), reason));
      await step.sendEvent("failed", contentPipelineFailed.create({ opportunityId, siteId, orgId, stage, error: reason }));
      return { ok: false as const, stage, error: reason };
    };

    const opp = await step.run("load-opportunity", () => loadOpportunity(opportunityId));
    if (!opp) return { ok: false as const, skipped: "opportunity not found" };
    if (opp.status === "published" || opp.status === "dismissed") return { ok: false as const, skipped: `opportunity is ${opp.status}` };
    await step.run("mark-in-progress", () => markOpportunity(opportunityId, "in_progress"));

    const gates = requiredGates(await step.run("load-policy", () => loadApprovalPolicy(siteId)));
    const site = await step.run("load-site", async () => {
      const route = await loadSiteRoute(siteId);
      if (!route) throw new Error(`site ${siteId} not found`);
      return { route, organization: await loadSiteOrganization(siteId), author: await defaultAuthor(siteId) };
    });
    const organizationName = site.organization.name ?? site.route.canonicalDomain;

    try {
      // ── brief ─────────────────────────────────────────────────────────
      let briefId: string | null = null;
      let spec: BriefSpec | null = null;
      let briefNote = note;
      let previousBrief: BriefSpec | null = null;
      for (let v = 1; v <= MAX_BRIEF_VERSIONS; v++) {
        stage = "brief";
        const brief = await step.run(`brief:${v}`, async () => {
          const ctx = await loadBriefContext(opp);
          const { spec, run } = await generateBrief(modelFor("pipeline.brief"), { ...ctx, note: briefNote, previous: previousBrief }, { orgId, siteId });
          const { id } = await insertBrief({ siteId, opportunityId, version: v, spec, run });
          return { id, spec };
        });
        if (briefId) await step.run(`brief:${v}:supersede-previous`, () => setBriefStatus(briefId!, "superseded"));
        briefId = brief.id;
        spec = brief.spec;
        if (!gates.includes("brief")) {
          await step.run(`brief:${v}:auto-approve`, () => setBriefStatus(brief.id, "approved"));
          break;
        }
        stage = "brief_gate";
        await step.run(`brief:${v}:pending`, () => setBriefStatus(brief.id, "pending_approval"));
        const gate = await humanGate(step, `brief-gate:${v}`, {
          kind: "brief",
          siteId,
          orgId,
          briefId: brief.id,
          notice: {
            kind: "brief",
            title: brief.spec.title,
            summary: brief.spec.targetAnswer,
            previewUrl: `${appUrl()}/briefs/${brief.id}`,
            facts: [
              { label: "Head question", value: brief.spec.headQuestion },
              { label: "Sections", value: String(brief.spec.outline.length) },
              { label: "Sources", value: String(brief.spec.sources.length) },
              { label: "Brand facts", value: String(brief.spec.facts.length) },
            ],
          },
        });
        if (!gate) return await fail(`brief approval expired after ${GATE_TIMEOUT}`);
        if (gate.decision === "approve") {
          await step.run(`brief:${v}:approved`, () => setBriefStatus(brief.id, "approved"));
          break;
        }
        await step.run(`brief:${v}:changes`, () => setBriefStatus(brief.id, "changes_requested"));
        if (v === MAX_BRIEF_VERSIONS) return await fail(`brief rejected ${MAX_BRIEF_VERSIONS} times`);
        briefNote = gate.note;
        previousBrief = gate.decision === "changes" ? brief.spec : null;
      }
      if (!briefId || !spec) return await fail("no approved brief");
      const approvedBrief = spec;
      const approvedBriefId = briefId;

      // ── content item ──────────────────────────────────────────────────
      const item = await step.run("content-item", async () => {
        if (opp.content_item_id) {
          const existing = await loadContentItem(opp.content_item_id);
          if (existing) {
            await appDb()`update content.content_items set brief_id = ${approvedBriefId}, updated_at = now() where id = ${existing.id}`;
            return { id: existing.id, slug: existing.slug, refresh: true };
          }
        }
        const slug = await reserveSlug(siteId, slugify(approvedBrief.title));
        const { id } = await createContentItem({ siteId, slug, title: approvedBrief.title, briefId: approvedBriefId, authorId: site.author?.id ?? null, opportunityId });
        return { id, slug, refresh: false };
      });

      // The manifesto the brief was written under is the one the draft is written under.
      const manifest = await step.run("load-manifest", async () => {
        if (!approvedBrief.manifestVersionId) return null;
        const row = await loadManifest(orgId, approvedBrief.manifestVersionId);
        return row ? manifestPromptBlock(row.doc) : null;
      });

      // ── draft → QA → (gate) ───────────────────────────────────────────
      let versionId: string | null = null;
      let reviewNote: string | null = null;
      let previousDraft: DraftOutput | null = null;
      let attemptNo = 0;
      rounds: for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
        let feedback: string[] = [];
        let passed = false;
        for (let qa = 1; qa <= MAX_QA_ATTEMPTS; qa++) {
          attemptNo++;
          stage = "draft";
          const r = await step.run(`draft:${attemptNo}`, async () => {
            const sql = appDb();
            const now = new Date();
            const { draft, run } = await generateDraft(
              modelFor("pipeline.draft"),
              {
                brief: approvedBrief,
                author: site.author ? { name: site.author.name, jobTitle: site.author.job_title } : { name: organizationName },
                site: { organizationName, domain: site.route.canonicalDomain },
                manifest,
                feedback,
                note: reviewNote,
                previous: previousDraft,
              },
              { orgId, siteId, contentItemId: item.id },
              sql,
            );
            const composed = composeVersion({ draft, brief: approvedBrief, site: site.route, organization: site.organization, author: site.author, slug: item.slug, datePublished: now });
            const report = await runQaGates(
              { title: draft.title, bodyMd: composed.bodyMd, bodyHtml: composed.bodyHtml, sources: approvedBrief.sources, facts: approvedBrief.facts, intent: approvedBrief.intent, jsonLd: composed.page.jsonLd, now },
              { fetchImpl: fetch, loadFacts: (ids) => loadFactStatuses(orgId, ids, sql, now) },
            );
            const version = await insertVersion(
              {
                contentItemId: item.id,
                title: draft.title,
                description: draft.description,
                bodyMd: composed.bodyMd,
                bodyHtml: composed.bodyHtml,
                frontmatter: { intent: approvedBrief.intent, faq: composed.faq, briefId: approvedBriefId, attempt: attemptNo },
                schemaJsonLd: composed.page.jsonLd,
                structureScore: report.structure,
                wordCount: composed.wordCount,
                run,
                manifestVersionId: approvedBrief.manifestVersionId,
              },
              sql,
            );
            await insertSources(version.id, composed.cited, report.verifications, sql, now);
            await insertContentFacts(version.id, report.citedFacts, sql);
            await insertQaResults(version.id, report.gates, sql);
            return { versionId: version.id, versionNo: version.versionNo, draft, passed: report.passed, routeTo: report.routeTo, feedback: report.feedback, wordCount: composed.wordCount, structure: report.structure.normalized };
          });
          versionId = r.versionId;
          previousDraft = r.draft;
          if (r.passed) {
            passed = true;
            break;
          }
          stage = "qa";
          if (r.routeTo === "brief") return await fail(`QA routed back to the brief: ${r.feedback[0] ?? "brief supplied no citable sources"}`);
          feedback = r.feedback;
        }
        if (!passed) return await fail(`draft failed QA ${MAX_QA_ATTEMPTS} times: ${feedback.slice(0, 3).join(" | ")}`);
        if (!gates.includes("draft")) break;

        stage = "draft_gate";
        const gate = await humanGate(step, `draft-gate:${round}`, {
          kind: "draft",
          siteId,
          orgId,
          contentVersionId: versionId,
          notice: {
            kind: "draft",
            title: previousDraft!.title,
            summary: previousDraft!.description,
            previewUrl: `${appUrl()}/content/${item.id}/versions/${versionId}`,
            facts: [{ label: "Path", value: `${site.route.pathPrefix}/${item.slug}` }],
          },
        });
        if (!gate) return await fail(`draft approval expired after ${GATE_TIMEOUT}`);
        if (gate.decision === "approve") break rounds;
        if (round === MAX_REVIEW_ROUNDS) return await fail(`draft rejected ${MAX_REVIEW_ROUNDS} times`);
        reviewNote = gate.note;
        if (gate.decision === "regenerate") previousDraft = null;
      }
      if (!versionId) return await fail("no approved version");
      const finalVersionId = versionId;

      // ── publish ───────────────────────────────────────────────────────
      stage = "publish";
      // The pre-publish baseline: attribution needs a valid "before".
      if (opp.question_id) await step.sendEvent("baseline", serpTrackRequested.create({ siteId, orgId, questionIds: [opp.question_id] }));
      const published = await step.run("publish", async () => {
        const sql = appDb();
        const version = await loadVersion(finalVersionId, sql);
        if (!version) throw new Error(`version ${finalVersionId} vanished`);
        const [dates] = await sql<{ first_published_at: Date | null }[]>`select first_published_at from content.content_items where id = ${item.id}`;
        const now = new Date();
        const composed = composeVersion({
          draft: { title: version.title, description: version.description ?? "", bodyMd: version.body_md, faq: version.frontmatter.faq },
          brief: { sources: await loadSources(finalVersionId, sql), intent: version.frontmatter.intent },
          site: site.route,
          organization: site.organization,
          author: site.author,
          slug: item.slug,
          datePublished: dates?.first_published_at ?? now,
          dateModified: now,
        });
        const result = await publishVersion({ contentItemId: item.id, versionId: finalVersionId, siteId, page: composed.page, now }, sql);
        await markOpportunity(opportunityId, "published", sql);
        return result;
      });
      await step.sendEvent("published", contentPublished.create({ contentItemId: item.id, versionId: finalVersionId, siteId, orgId, path: published.path, canonicalUrl: published.canonicalUrl }));

      // ── post-publish loop ─────────────────────────────────────────────
      if (!opp.question_id) return { ok: true as const, contentItemId: item.id, versionId: finalVersionId, path: published.path, windows: [] };
      const questionId = opp.question_id;
      const publishedAt = new Date();
      const windows: { days: number; owned: boolean | null }[] = [];
      for (const days of POST_PUBLISH_WINDOWS_DAYS) {
        await step.sleepUntil(`window:${days}d`, windowDate(publishedAt, days));
        await step.sendEvent(`window:${days}d:track`, serpTrackRequested.create({ siteId, orgId, questionIds: [questionId] }));
        // Give the tracker time to land the snapshot before we read it.
        await step.sleep(`window:${days}d:settle`, "30m");
        const status = await step.run(`window:${days}d:check`, () => citationStatus(questionId));
        windows.push({ days, owned: status?.owned ?? null });
        if (status && !status.owned) {
          await step.run(`window:${days}d:refresh`, () =>
            openRefreshOpportunity({
              siteId,
              contentItemId: item.id,
              questionId,
              title: opp.title,
              targetQuery: opp.target_query,
              windowDays: days,
              evidence: { snapshotId: status.snapshotId, fetchedAt: status.fetchedAt, aioTriggered: status.aioTriggered, competitorDomains: status.competitorDomains, publishedAt, path: published.path },
            }),
          );
        }
      }
      return { ok: true as const, contentItemId: item.id, versionId: finalVersionId, path: published.path, windows };
    } catch (e) {
      // Let Inngest retry transient errors; on the last attempt record the failure so the queue is honest.
      if (attempt >= 2) await fail(`${stage}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  },
);

/** Record a human decision (from Slack, the app or ops) and rewrite the Slack message so it cannot be clicked twice. */
export const approvalDecidedFunction = inngest.createFunction(
  { id: "approval-decided", triggers: [approvalDecided], retries: 2 },
  async ({ event, step }) => {
    const { approvalId, decision, by, source, note } = event.data;
    const applied = await step.run("record", () =>
      recordDecision(approvalId, { decision, by: { userId: by.userId ?? null, name: by.name ?? null }, source, note: note ?? null }),
    );
    if (!applied.applied) return { applied: false };
    await step.run("update-slack", async () => {
      const approval = await loadApproval(approvalId);
      if (!approval?.slack_ts) return false;
      const notice = await noticeFor(approval.kind, approval.brief_id, approval.content_version_id, approvalId);
      if (!notice) return false;
      return updateSlackDecision(approval, decision, by.name ?? by.userId ?? source, notice, connectorContext());
    });
    return { applied: true };
  },
);

async function noticeFor(kind: ApprovalKind, briefId: string | null, versionId: string | null, approvalId: string): Promise<ApprovalNotice | null> {
  if (kind === "brief" && briefId) {
    const brief = await loadBrief(briefId);
    return brief ? { approvalId, kind, title: brief.spec.title, summary: brief.target_answer, previewUrl: `${appUrl()}/briefs/${briefId}` } : null;
  }
  if (kind === "draft" && versionId) {
    const version = await loadVersion(versionId);
    return version ? { approvalId, kind, title: version.title, summary: version.description ?? "", previewUrl: `${appUrl()}/content/${version.content_item_id}/versions/${versionId}` } : null;
  }
  return null;
}

/** Rebuild one site's opportunity queue from its citation gaps. */
export const opportunityScanFunction = inngest.createFunction(
  { id: "opportunity-scan", triggers: [opportunitiesScanRequested], concurrency: [{ key: "event.data.siteId", limit: 1 }], retries: 1 },
  async ({ event, step }) => step.run("scan", () => scanSite(event.data.siteId)),
);

/** Nightly, after the SERP trackers: every active site gets a fresh queue. */
export const opportunityScanNightly = inngest.createFunction(
  { id: "opportunity-scan-nightly", triggers: [{ cron: "0 9 * * *" }], retries: 0 },
  async ({ step }) => {
    const sites = await step.run("list-sites", () => appDb()<{ id: string; org_id: string }[]>`select id, org_id from app.sites where status = 'active'`);
    if (sites.length === 0) return { sites: 0 };
    await step.sendEvent("fan-out", sites.map((s) => opportunitiesScanRequested.create({ siteId: s.id, orgId: s.org_id })));
    return { sites: sites.length };
  },
);

export const pipelineFunctions = [contentPipelineFunction, approvalDecidedFunction, opportunityScanFunction, opportunityScanNightly];
