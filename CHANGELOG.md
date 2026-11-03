# Changelog

## 0.1.0 (2026-10-27)

- Initial release: eight MCP tools and matching CLI
  subcommands over the public Federal Register API v1 —
  `search_documents`, `get_document`,
  `get_documents_batch` (up to 20 document numbers),
  `get_facet_counts`, `get_public_inspection`,
  `list_agencies`, plus the labelled compositions
  `open_comment_periods` and `far_case_history`.
- Flat arguments map to the API's `conditions[...]`
  parameters; `comment_date_gte` / `comment_date_lte` are
  labelled client-side filters on `comments_close_on`,
  because the API publishes no such condition.
- Pacing built in: at least 300 ms between request starts,
  and on HTTP 429 a single retry after the `Retry-After`
  interval (60 seconds by default). Keyless; the base URL
  is overridable via `FEDERAL_REGISTER_API_BASE`.
