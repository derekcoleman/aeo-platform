-- ============================================================================
-- 0016 — Custom connectors.
--
-- connector_provider 'custom'  a customer-defined source: an HTTP API that
--                              returns JSON or text, or an MCP server whose
--                              resources are read. Both land in
--                              context.context_documents like Slack and the
--                              website crawl, so the brand brain sees them
--                              with no extra plumbing. The token (if any)
--                              lives in Vault; config holds the URL, the
--                              kind and the field mapping only.
-- ============================================================================

alter type context.connector_provider add value if not exists 'custom';
