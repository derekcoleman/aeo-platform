-- ============================================================================
-- 0026 — Competitor organic gap enum value (ADD VALUE only).
--
-- A value added to an enum cannot be used in the transaction that adds it,
-- so this stands alone and 0027 (and the job) use it.
--
-- content.opportunity_source  + competitor: work opened because a named
--                             competitor ranks in Google's organic top 10
--                             for a keyword the site does not
--                             (lib/strategy/competitor-gap.ts).
--                             measure.question_source already has
--                             'competitor' (0004).
-- ============================================================================

alter type content.opportunity_source add value if not exists 'competitor';
