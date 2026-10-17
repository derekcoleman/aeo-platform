-- ============================================================================
-- 0023 — Answer ledger enum values (ADD VALUE only).
--
-- A value added to an enum cannot be used in the transaction that adds it,
-- so these stand alone and 0024 uses them.
--
-- measure.citation_surface  + llm_answer: a source an AI answer engine cited
--                           (ChatGPT, Perplexity, Gemini, Claude, Copilot…).
--                           + ai_mode: a source Google AI Mode cited. Neither
--                           is a Google AI Overview.
-- measure.serp_provider     + openrouter: an answer probe sent through
--                           OpenRouter (lib/answers/openrouter-probe.ts).
-- ============================================================================

alter type measure.citation_surface add value if not exists 'llm_answer';
alter type measure.citation_surface add value if not exists 'ai_mode';
alter type measure.serp_provider add value if not exists 'openrouter';
