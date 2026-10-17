import { createHash } from "node:crypto";
import type postgres from "postgres";
import { appDb } from "@/lib/db/app";
import { citationRole, contentIdForUrl, isOwnedUrl, type SiteOwnership } from "@/lib/demand/store";
import { loadSourceRoleContext } from "@/lib/measure/source-roles";
import { searchTag, type AnswerEngineConfig } from "./engines";
import { extractMentions, loadMentionIndex, MENTION_EXTRACTOR_VERSION } from "./mentions";
import type { ProbeResult } from "./openrouter-probe";

/**
 * Write one probe answer to the answer ledger: a measure.serp_snapshots row
 * (provider openrouter, collection_method api_probe, the engine, the model
 * that answered with how it searched, the sample, the run, the answer and
 * whether its sources were observable), its sources as measure.serp_citations
 * on the llm_answer surface (owned or not, the published asset behind an
 * owned one, the cited site's role and competitor), and the brand and named
 * competitors it mentions as measure.answer_mentions. One transaction, like
 * recordSnapshot: the roles and the alias index are read inside it, so they
 * are never older than the rows they classify.
 *
 * A step that runs again after its write committed finds its own row (the
 * same question, engine, sample, wording and run) and writes nothing.
 */

export interface ObservationMeta {
  sampleIndex: number;
  runId: string | null;
  paraphraseId?: string | null;
  /** The question's locale, as its SERP snapshots carry it. */
  locale: string;
  /** The answer came from the day's answer cache: no new spend. */
  cached: boolean;
  costUsd: number;
}

export interface ObservationResult {
  snapshotId: string;
  /** The row was already there: nothing was written. */
  duplicate: boolean;
  citations: number;
  ownedCitations: number;
  mentions: number;
  brandMentioned: boolean;
  brandRecommended: boolean;
}

export function answerHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function recordAnswerObservation(
  own: SiteOwnership,
  questionId: string,
  cfg: AnswerEngineConfig,
  probe: ProbeResult,
  meta: ObservationMeta,
  sql: postgres.Sql = appDb(),
): Promise<ObservationResult> {
  return sql.begin(async (trx) => {
    const tx = trx as unknown as postgres.Sql;
    const raw = {
      label: cfg.label,
      requestedModel: probe.requestedModel,
      search: cfg.search,
      searchEngine: cfg.searchEngine,
      finishReason: probe.finishReason,
      nativeFinishReason: probe.nativeFinishReason,
      stopReason: probe.stopReason,
      citationSource: probe.citationSource,
      upstreamProvider: probe.upstreamProvider,
      responseId: probe.responseId,
      usage: probe.usage,
    };
    const [snap] = await tx<{ id: string }[]>`
      insert into measure.serp_snapshots
        (site_id, question_id, provider, engine, model_version, collection_method, fetched_at, locale, device,
         aio_triggered, organic_count, cached, raw, cost_usd, sample_index, paraphrase_id, run_id,
         answer_text, answer_hash, citations_observable)
      values
        (${own.siteId}, ${questionId}, 'openrouter', ${cfg.engine}, ${`${probe.model}${searchTag(cfg)}`}, 'api_probe', ${probe.fetchedAt}, ${meta.locale}, 'api',
         null, 0, ${meta.cached}, ${tx.json(raw as never)}, ${meta.costUsd}, ${meta.sampleIndex}, ${meta.paraphraseId ?? null}, ${meta.runId},
         ${probe.text}, ${answerHash(probe.text)}, ${probe.citationsObservable})
      on conflict (question_id, engine, sample_index, paraphrase_id, run_id) where collection_method = 'api_probe' and run_id is not null
      do nothing
      returning id`;
    if (!snap) {
      const [again] = await tx<{ id: string }[]>`
        select id from measure.serp_snapshots
        where question_id = ${questionId} and engine = ${cfg.engine} and sample_index = ${meta.sampleIndex}
          and paraphrase_id is not distinct from ${meta.paraphraseId ?? null}::uuid and run_id = ${meta.runId} and collection_method = 'api_probe'`;
      return { snapshotId: again?.id ?? "", duplicate: true, citations: 0, ownedCitations: 0, mentions: 0, brandMentioned: false, brandRecommended: false };
    }

    const roles = await loadSourceRoleContext(own.siteId, own.orgId, tx, own.domains);
    let owned = 0;
    for (const c of probe.citations) {
      const isOwned = isOwnedUrl(c.url, own);
      const contentId = isOwned ? await contentIdForUrl(c.url, own, tx) : null;
      const source = citationRole(c.url, c.domain, own, roles);
      if (isOwned) owned += 1;
      await tx`
        insert into measure.serp_citations
          (site_id, serp_snapshot_id, surface, url, domain, position, position_in_answer, is_owned, content_id, title, snippet, source_role, entity_id)
        values
          (${own.siteId}, ${snap.id}, 'llm_answer', ${c.url}, ${c.domain}, ${c.position}, ${c.positionInAnswer}, ${isOwned}, ${contentId},
           ${c.title}, ${c.snippet}, ${source.role}, ${source.entityId})`;
    }

    const mentions = extractMentions(probe.text, await loadMentionIndex(own.orgId, tx));
    for (const m of mentions) {
      await tx`
        insert into measure.answer_mentions
          (snapshot_id, site_id, entity_id, is_brand, matched_alias, mention_count, first_offset, list_rank, is_listed, is_recommended, extractor_version)
        values
          (${snap.id}, ${own.siteId}, ${m.entityId}, ${m.isBrand}, ${m.matchedAlias}, ${m.mentionCount}, ${m.firstOffset},
           ${m.listRank}, ${m.isListed}, ${m.isRecommended}, ${MENTION_EXTRACTOR_VERSION})`;
    }
    return {
      snapshotId: snap.id,
      duplicate: false,
      citations: probe.citations.length,
      ownedCitations: owned,
      mentions: mentions.length,
      brandMentioned: mentions.some((m) => m.isBrand),
      brandRecommended: mentions.some((m) => m.isBrand && m.isRecommended),
    };
  });
}
