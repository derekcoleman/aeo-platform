import { ModelRefusalError } from "@/lib/ai/model";
import { connectorContext } from "@/lib/connectors";
import { appDb } from "@/lib/db/app";
import { BudgetExceededError } from "@/lib/ops/spend";
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
import { loadFactStatuses, loadInternalTerms } from "@/lib/context/facts";
import { loadManifest, manifestPromptBlock } from "@/lib/context/manifest";
import { generateBrief, insertBrief, loadBrief, loadBriefContext, setBriefStatus } from "@/lib/pipeline/briefs";
import { composeVersion, qaDocumentFor } from "@/lib/pipeline/compose";
import { generateDraft, slugify } from "@/lib/pipeline/draft";
import { applyDecision, approvalUrl, GATE_TTL_DAYS, humanGate, type DecisionDeps, type GateDeps } from "@/lib/pipeline/gate";
import { citationStatus, loadPublishedAt, POST_PUBLISH_WINDOWS_DAYS, windowDate, windowsStart } from "@/lib/pipeline/loop";
import { ArticleBudgetExceededError, assertArticleBudget, modelFor, ModelTruncatedError, TASK_SETTINGS } from "@/lib/pipeline/model";
import { coverageGuard } from "@/lib/pipeline/coverage";
import { loadOpportunity, markFailed, markOpportunity, openRefreshOpportunity, scanSite, type DismissReason } from "@/lib/pipeline/opportunities";
import { heldFor, holdWhilePaused, isHeld, publishGuard } from "@/lib/pipeline/guard";
import { isTakenDown, loadSiteOrganization, loadSiteRoute } from "@/lib/pipeline/publish";
import { runQaGates, safeSourceFetcher, safetySummary } from "@/lib/pipeline/qa";
import { recomposeFromVersion, remediateDuplicateFaq, sitesWithDuplicateFaq, type FaqRemediation } from "@/lib/pipeline/republish";
import { EXISTING_BODY_MAX_CHARS, importCmsItem, loadExistingContent, publishRefreshToCms } from "@/lib/refresh/publish";
import type { BriefSpec, DraftOutput } from "@/lib/pipeline/types";
import {
  createContentItem,
  defaultAuthor,
  insertContentFacts,
  insertQaResults,
  insertSources,
  insertVersion,
  loadContentItem,
  loadVersion,
  reserveSlug,
} from "@/lib/pipeline/versions";
import {
  approvalDecided,
  concurrencyCap,
  contentPipelineFailed,
  contentPipelineRequested,
  contentPublished,
  contentRemediateFaqRequested,
  inngest,
  opportunitiesScanRequested,
  publishingPushRequested,
  serpTrackRequested,
} from "./client";

/**
 * The content pipeline as one durable function: (coverage guard) → brief →
 * (human gate) → draft → QA → (human gate) → publish → +14/+30/+60d
 * re-measure. Every LLM call and every DB write sits in its own `step.run`,
 * so a retry after a provider blip re-pays nothing that completed, and the
 * gates are `waitForEvent`s that hold the run for days with its state
 * intact.
 */

const MAX_BRIEF_VERSIONS = 3;
const MAX_QA_ATTEMPTS = 3;
const MAX_REVIEW_ROUNDS = 2;

function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_URL ?? "https://app.aeo.app").replace(/\/$/, "");
}

function gateDeps(): GateDeps {
  return {
    createApproval: (input) => createApproval(input),
    loadApproval: (id) => loadApproval(id),
    expireApproval: (id) => expireApproval(id),
    notifyApprovalSlack: (orgId, notice) => notifyApprovalSlack(orgId, notice, connectorContext()),
    appUrl: appUrl(),
  };
}

/**
 * Model outcomes caught inside their step and returned, not thrown. A refusal
 * is not retried by Inngest; the run hands it to a human. A cut-off comes
 * back with the larger budget, and the retry runs in a step of its own, so
 * each long call gets its own invocation (and request timeout) and a replay
 * never pays for the first call again. A spent budget (the article's cap, or
 * the org's model budget for the month) is not retried either: another
 * attempt minutes later finds it just as spent, and raising it is a person's
 * call.
 */
function handedBack(e: unknown): { refused: string } | { truncated: number } | { overBudget: string } | null {
  if (e instanceof ModelRefusalError) return { refused: e.category ?? "no category given" };
  if (e instanceof ModelTruncatedError) return { truncated: e.retryMaxTokens };
  if (e instanceof ArticleBudgetExceededError || e instanceof BudgetExceededError) return { overBudget: e.message };
  return null;
}

export const contentPipelineFunction = inngest.createFunction(
  {
    id: "content-pipeline",
    triggers: [contentPipelineRequested],
    concurrency: [{ key: "event.data.orgId", limit: 2 }, { limit: concurrencyCap(10) }],
    retries: 2,
  },
  async ({ event, step, attempt, runId }) => {
    const { opportunityId, siteId, orgId, note = null } = event.data;
    const scope = { orgId, siteId, runId, opportunityId };
    let stage: "brief" | "brief_gate" | "draft" | "qa" | "draft_gate" | "publish" = "brief";

    const fail = async (reason: string, code?: DismissReason) => {
      await step.run(`fail:${stage}`, () => (code ? markFailed(opportunityId, reason, code) : markOpportunity(opportunityId, "failed", appDb(), reason)));
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
      // ── coverage guard ────────────────────────────────────────────────
      // One canonical URL per intent, and nothing off-topic written by a
      // scan: automated new-page work is checked before any model is paid.
      // The run goes on from the guard's answer (it may have become a
      // refresh of an existing page), never from the opportunity loaded above.
      const guard = await step.run("coverage-guard", () => coverageGuard(opp));
      if (!guard.proceed) return { ok: false as const, skipped: guard.reason, dismissed: guard.dismissReason };
      const work = { ...opp, action_type: guard.actionType, content_item_id: guard.contentItemId, evidence: guard.evidence };
      // Sent to an existing page by the guard, the run rewrites that page in
      // place (a CMS post is overwritten), not the new page that was asked
      // for: a person sees the draft first, whatever the approval policy.
      const covered = guard.checked && guard.actionType !== "new_page" ? (guard.evidence.coverage as { url?: string | null; title?: string | null } | undefined) : undefined;
      const replaces = covered ? { label: "Replaces", value: `${covered.url ?? covered.title ?? "an existing page"}: the site already answers this question there, so this rewrites that page in place` } : null;

      // ── brief ─────────────────────────────────────────────────────────
      let briefId: string | null = null;
      let spec: BriefSpec | null = null;
      let briefNote = note;
      let previousBrief: BriefSpec | null = null;
      for (let v = 1; v <= MAX_BRIEF_VERSIONS; v++) {
        stage = "brief";
        const writeBrief = (maxTokens: number) => async () => {
          const ctx = await loadBriefContext(work);
          try {
            await assertArticleBudget(opportunityId);
            const { spec, run } = await generateBrief(modelFor("pipeline.brief"), { ...ctx, note: briefNote, previous: previousBrief }, scope, appDb(), { maxTokens, retryTruncated: false });
            const { id } = await insertBrief({ siteId, opportunityId, version: v, spec, run });
            return { id, spec };
          } catch (e) {
            const handed = handedBack(e);
            if (handed) return handed;
            throw e;
          }
        };
        let brief = await step.run(`brief:${v}`, writeBrief(TASK_SETTINGS["pipeline.brief"].maxTokens));
        if ("truncated" in brief) brief = await step.run(`brief:${v}:more-room`, writeBrief(brief.truncated));
        if ("overBudget" in brief) return await fail(`brief not written: ${brief.overBudget} — needs a human`);
        if ("refused" in brief) return await fail(`model refused the brief (${brief.refused}) — needs a human`, "model_refusal");
        if ("truncated" in brief) return await fail("the brief was cut off at max_tokens even with more room — needs a human");
        if (briefId) await step.run(`brief:${v}:supersede-previous`, () => setBriefStatus(briefId!, "superseded"));
        briefId = brief.id;
        spec = brief.spec;
        if (!gates.includes("brief")) {
          await step.run(`brief:${v}:auto-approve`, () => setBriefStatus(brief.id, "approved"));
          break;
        }
        stage = "brief_gate";
        await step.run(`brief:${v}:pending`, () => setBriefStatus(brief.id, "pending_approval"));
        const gate = await humanGate(
          step,
          `brief-gate:${v}`,
          {
            kind: "brief",
            siteId,
            orgId,
            briefId: brief.id,
            notice: {
              kind: "brief",
              title: brief.spec.title,
              summary: brief.spec.targetAnswer,
              facts: [
                { label: "Head question", value: brief.spec.headQuestion },
                { label: "Sections", value: String(brief.spec.outline.length) },
                { label: "Sources", value: String(brief.spec.sources.length) },
                { label: "Brand facts", value: String(brief.spec.facts.length) },
                ...(replaces ? [replaces] : []),
              ],
            },
          },
          gateDeps(),
        );
        if (!gate) return await fail(`brief approval expired after ${GATE_TTL_DAYS} days`);
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
      // Three cases: an item of ours being refreshed, a CMS post being
      // imported for its first refresh (cms origin: published back to the
      // CMS in place, never to the proxy), or a brand-new article.
      const item = await step.run("content-item", async () => {
        const sql = appDb();
        if (work.content_item_id) {
          const existing = await loadContentItem(work.content_item_id, sql);
          if (existing) {
            await sql`update content.content_items set brief_id = ${approvedBriefId}, updated_at = now() where id = ${existing.id}`;
            return { id: existing.id, slug: existing.slug, refresh: true, origin: existing.origin };
          }
        }
        const cmsItemId = typeof work.evidence.cmsItemId === "string" ? work.evidence.cmsItemId : null;
        if (cmsItemId) {
          const imported = await importCmsItem(cmsItemId, { opportunityId, authorId: site.author?.id ?? null }, sql);
          await sql`update content.content_items set brief_id = ${approvedBriefId}, updated_at = now() where id = ${imported.id}`;
          await sql`update content.opportunities set content_item_id = ${imported.id}, updated_at = now() where id = ${opportunityId}`;
          return { id: imported.id, slug: imported.slug, refresh: true, origin: "cms" as const };
        }
        const slug = await reserveSlug(siteId, slugify(approvedBrief.title), sql);
        const { id } = await createContentItem({ siteId, slug, title: approvedBrief.title, briefId: approvedBriefId, authorId: site.author?.id ?? null, opportunityId }, sql);
        return { id, slug, refresh: false, origin: "pipeline" as const };
      });

      // A refresh drafts from the live article, not from a blank page.
      const existing = item.refresh ? await step.run("load-existing", () => loadExistingContent({ content_item_id: item.id, evidence: work.evidence })) : null;

      // The manifesto the brief was written under is the one the draft is written under.
      const manifest = await step.run("load-manifest", async () => {
        if (!approvedBrief.manifestVersionId) return null;
        const row = await loadManifest(orgId, approvedBrief.manifestVersionId);
        return row ? manifestPromptBlock(row.doc) : null;
      });

      // ── draft → QA → (gate) ───────────────────────────────────────────
      let versionId: string | null = null;
      let reviewNote: string | null = null;
      // The live FAQ rides in `faq`, as a draft returns it; loadExistingContent cut it out of the body.
      let previousDraft: DraftOutput | null = existing ? { title: existing.title, description: existing.description ?? approvedBrief.description, bodyMd: existing.bodyMd, faq: existing.faq } : null;
      const refresh = existing ? { url: existing.url, lastUpdated: existing.lastUpdated, reasons: existing.reasons, actionType: work.action_type } : null;
      // A figures-and-dates update is held to the live page by the scope gate.
      const keep = existing && work.action_type === "update_stats" ? { title: existing.title, bodyMd: existing.bodyMd, truncated: existing.bodyMd.length >= EXISTING_BODY_MAX_CHARS } : undefined;
      let attemptNo = 0;
      // A safety finding on any attempt (an email address, an internal name,
      // an injected instruction…) puts a person in front of the draft, even
      // under auto-publish: a later attempt that drops it is still one
      // someone should look at.
      let safetyFindings: string[] = [];
      rounds: for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
        let feedback: string[] = [];
        let passed = false;
        for (let qa = 1; qa <= MAX_QA_ATTEMPTS; qa++) {
          attemptNo++;
          stage = "draft";
          const writeDraft = (maxTokens: number) => async () => {
            const sql = appDb();
            const now = new Date();
            let generated: Awaited<ReturnType<typeof generateDraft>>;
            try {
              await assertArticleBudget(opportunityId, sql);
              generated = await generateDraft(
                modelFor("pipeline.draft"),
                {
                  brief: approvedBrief,
                  author: site.author ? { name: site.author.name, jobTitle: site.author.job_title } : { name: organizationName },
                  site: { organizationName, domain: site.route.canonicalDomain },
                  manifest,
                  feedback,
                  note: reviewNote,
                  previous: previousDraft,
                  refresh: previousDraft && refresh && attemptNo === 1 ? refresh : null,
                  allowFaq: approvedBrief.allowFaq,
                },
                { ...scope, contentItemId: item.id },
                sql,
                { maxTokens, retryTruncated: false },
              );
            } catch (e) {
              const handed = handedBack(e);
              if (handed) return handed;
              throw e;
            }
            const { draft, run } = generated;
            const composed = composeVersion({ draft, brief: approvedBrief, site: site.route, organization: site.organization, author: site.author, slug: item.slug, datePublished: now });
            // Structure is scored on what goes live: the renderer's document for a proxy page, the body for a cms item.
            const document = qaDocumentFor(composed, item.origin, site.route, site.organization, item.slug);
            const report = await runQaGates(
              {
                title: draft.title,
                description: draft.description,
                faq: composed.faq,
                allowFaq: approvedBrief.allowFaq,
                bodyMd: composed.bodyMd,
                bodyHtml: composed.bodyHtml,
                sources: approvedBrief.sources,
                facts: approvedBrief.facts,
                intent: approvedBrief.intent,
                jsonLd: composed.page.jsonLd,
                ...document,
                keep,
                now,
              },
              { fetchSource: safeSourceFetcher(), loadFacts: (ids) => loadFactStatuses(orgId, ids, sql, now), loadInternalTerms: () => loadInternalTerms(orgId, sql) },
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
            return { versionId: version.id, versionNo: version.versionNo, draft, passed: report.passed, routeTo: report.routeTo, feedback: report.feedback, wordCount: composed.wordCount, structure: report.structure.normalized, safety: report.requiresHuman ? safetySummary(report.safety) : [] };
          };
          let r = await step.run(`draft:${attemptNo}`, writeDraft(TASK_SETTINGS["pipeline.draft"].maxTokens));
          if ("truncated" in r) r = await step.run(`draft:${attemptNo}:more-room`, writeDraft(r.truncated));
          if ("overBudget" in r) return await fail(`draft not written: ${r.overBudget} — needs a human`);
          if ("refused" in r) return await fail(`model refused the draft (${r.refused}) — needs a human`, "model_refusal");
          if ("truncated" in r) return await fail("the draft was cut off at max_tokens even with more room — needs a human");
          versionId = r.versionId;
          previousDraft = r.draft;
          // Absent on a draft step replayed from before the safety gate.
          if (r.safety?.length) safetyFindings = [...new Set([...safetyFindings, ...r.safety])];
          if (r.passed) {
            passed = true;
            break;
          }
          stage = "qa";
          if (r.routeTo === "brief") return await fail(`QA routed back to the brief: ${r.feedback[0] ?? "brief supplied no citable sources"}`);
          feedback = r.feedback;
        }
        if (!passed) return await fail(`draft failed QA ${MAX_QA_ATTEMPTS} times: ${feedback.slice(0, 3).join(" | ")}`);
        if (!gates.includes("draft") && safetyFindings.length === 0 && !replaces) break;

        stage = "draft_gate";
        const gate = await humanGate(
          step,
          `draft-gate:${round}`,
          {
            kind: "draft",
            siteId,
            orgId,
            contentVersionId: versionId,
            notice: {
              kind: "draft",
              title: previousDraft!.title,
              summary: previousDraft!.description,
              facts: [
                { label: "Path", value: `${site.route.pathPrefix}/${item.slug}` },
                ...(replaces ? [replaces] : []),
                ...(safetyFindings.length ? [{ label: "Safety check", value: `review before publishing: ${safetyFindings.slice(0, 3).join("; ")}` }] : []),
              ],
            },
          },
          gateDeps(),
        );
        if (!gate) return await fail(`draft approval expired after ${GATE_TTL_DAYS} days`);
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
      // The kill switch is read inside the step that writes, and a held step
      // comes back as { held } to sleep and ask again (lib/pipeline/guard.ts).
      const outcome = await holdWhilePaused(step, (n) => step.run(n === 0 ? "publish" : `publish:${n}`, async () => {
        const sql = appDb();
        // The pipeline also holds at the site's publishing pace; a hold for that sleeps until a slot frees.
        const verdict = await publishGuard(siteId, sql, { velocity: true, contentItemId: item.id });
        if (!verdict.ok) return heldFor(verdict);
        const now = new Date();
        if (item.origin === "cms") {
          // Back to the CMS, same item, same slug. The proxy never serves this one.
          const r = await publishRefreshToCms({ contentItemId: item.id, versionId: finalVersionId, now }, connectorContext({ sql }));
          await markOpportunity(opportunityId, "published", sql);
          return { path: r.url ? new URL(r.url).pathname : `/${item.slug}`, canonicalUrl: r.url, etag: null, cms: true, publishedAt: now.toISOString() };
        }
        // The stored version is what QA passed; recompose it, never re-append its FAQ.
        const result = await recomposeFromVersion({ contentItemId: item.id, versionId: finalVersionId, siteId, now }, sql);
        await markOpportunity(opportunityId, "published", sql);
        return { ...result, cms: false, publishedAt: now.toISOString() };
      }));
      if (isHeld(outcome)) return await fail(`publishing paused: ${outcome.held}`);
      const published = outcome;
      // This item's page, taken down, stays down whatever this run published (publishVersion):
      // the version waits behind the takedown, and Restore is what copies it to the targets.
      const takenDown = "status" in published && published.status !== "live";
      if (published.canonicalUrl && !takenDown) await step.sendEvent("published", contentPublished.create({ contentItemId: item.id, versionId: finalVersionId, siteId, orgId, path: published.path, canonicalUrl: published.canonicalUrl }));

      // ── post-publish loop ─────────────────────────────────────────────
      if (!opp.question_id) return { ok: true as const, contentItemId: item.id, versionId: finalVersionId, path: published.path, windows: [] };
      const questionId = opp.question_id;
      // From the step's memoised result: a replay must not move the re-measure windows.
      const publishedAt = await windowsStart(step, published, () => loadPublishedAt(item.id));
      const windows: { days: number; owned: boolean | null }[] = [];
      let everCited = false;
      for (const days of POST_PUBLISH_WINDOWS_DAYS) {
        await step.sleepUntil(`window:${days}d`, windowDate(publishedAt, days));
        await step.sendEvent(`window:${days}d:track`, serpTrackRequested.create({ siteId, orgId, questionIds: [questionId] }));
        // Give the tracker time to land the snapshot before we read it.
        await step.sleep(`window:${days}d:settle`, "30m");
        const status = await step.run(`window:${days}d:check`, () => citationStatus(questionId, siteId));
        windows.push({ days, owned: status?.owned ?? null });
        if (status?.owned) everCited = true;
        if (status && !status.owned) {
          // A page taken out of the index since is not queued for a refresh: a rewrite of it is someone's call.
          await step.run(`window:${days}d:refresh`, async () =>
            (await isTakenDown(item.id)) ? { inserted: 0, updated: 0 } : openRefreshOpportunity({
              siteId,
              contentItemId: item.id,
              questionId,
              topicId: opp.topic_id,
              // Cited at an earlier window and not now: a lost citation. Never cited: the gap it was written for is still open.
              gapType: everCited ? "refresh_lost_citation" : status.namedCompetitors > 0 ? "aio_named_competitor" : "aio_other_sources",
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

function decisionDeps(): DecisionDeps {
  return {
    recordDecision: (approvalId, input) => recordDecision(approvalId, input),
    loadApproval: (id) => loadApproval(id),
    noticeFor: (approval) => noticeFor(approval.kind, approval.brief_id, approval.content_version_id, approval.id),
    updateSlackDecision: (approval, decision, by, notice) => updateSlackDecision(approval, decision, by, notice, connectorContext()),
  };
}

/** Record a human decision and retire its Slack buttons; see applyDecision. */
export const approvalDecidedFunction = inngest.createFunction(
  { id: "approval-decided", triggers: [approvalDecided], retries: 2 },
  async ({ event, step }) => applyDecision(step, event.data, decisionDeps()),
);

async function noticeFor(kind: ApprovalKind, briefId: string | null, versionId: string | null, approvalId: string): Promise<ApprovalNotice | null> {
  const previewUrl = approvalUrl(appUrl(), approvalId);
  if (kind === "brief" && briefId) {
    const brief = await loadBrief(briefId);
    return brief ? { approvalId, kind, title: brief.spec.title, summary: brief.target_answer, previewUrl } : null;
  }
  if (kind === "draft" && versionId) {
    const version = await loadVersion(versionId);
    return version ? { approvalId, kind, title: version.title, summary: version.description ?? "", previewUrl } : null;
  }
  return null;
}

/**
 * Staff remediation: republish live pages that carry their FAQ section twice,
 * then push their Webflow copies again (publishing-push, one target each).
 * Model-free, idempotent.
 */
export const contentRemediateFaqFunction = inngest.createFunction(
  { id: "content-remediate-faq", triggers: [contentRemediateFaqRequested], concurrency: [{ limit: concurrencyCap(1) }], retries: 1 },
  async ({ event, step }) => {
    const sites = await step.run("sites", () => sitesWithDuplicateFaq(event.data.siteId ?? null));
    const results: FaqRemediation[] = [];
    // One step per site: a timeout or a retry keeps the sites already fixed, and their audit rows.
    for (const siteId of sites) results.push(...(await step.run(`remediate:${siteId}`, () => remediateDuplicateFaq(siteId, { actorUserId: event.data.requestedBy ?? null }))));
    const pushes = results.flatMap((r) => r.repush.map((p) => publishingPushRequested.create({ siteId: r.siteId, orgId: r.orgId, contentItemId: p.contentItemId, targetId: p.targetId })));
    if (pushes.length) await step.sendEvent("repush-webflow", pushes);
    return { sites: results.length, pages: results.reduce((n, r) => n + r.paths.length, 0), skipped: results.reduce((n, r) => n + r.skipped.length, 0), repushed: pushes.length };
  },
);

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

export const pipelineFunctions = [contentPipelineFunction, approvalDecidedFunction, opportunityScanFunction, opportunityScanNightly, contentRemediateFaqFunction];
