# fedregister

The Federal Register is where the United States government
publishes what it is about to do and what it has done:
final rules, proposed rules open for public comment,
notices, and presidential documents. fedregister wraps the
Register's public API v1 in a small CLI and a stdio MCP
server, so a person — or an agent — can search that record,
watch comment deadlines, and pull the history of a
rulemaking without scraping web pages. The API is public
and keyless; no account or token is needed.

What the eight tools do:

- `search_documents` — search everything published since
  1994. Flat arguments (term, document types, agencies,
  docket id, regulation id number, CFR title/part, sections,
  topics, significance, publication and effective date
  bounds, paging, ordering, field selection) are translated
  into the API's `conditions[...]` query parameters.
- `get_document` — fetch one document by its document
  number.
- `get_documents_batch` — fetch up to 20 documents in a
  single call.
- `get_facet_counts` — counts of matching documents grouped
  by a facet: a document field such as type, agency, or
  topic, or a time bucket from daily through yearly.
- `get_public_inspection` — search the pre-publication
  filings currently on public inspection, including the
  `available_on` date and the `special_filing` flag.
- `list_agencies` — every agency that publishes in the
  Register.
- `open_comment_periods` — a labelled composition: it pages
  through recent documents (a scan window reaching 120 days
  back, at most 5 pages of 1000), keeps the ones whose
  comment period is still open, and returns them sorted by
  deadline as `{results, complete, truncated}`, where
  `complete` says whether the whole scan window was read
  and `truncated` whether the `limit` (default 50) cut the
  list.
- `far_case_history` — a labelled composition: the full
  document history of a FAR/DFARS case, searched by case
  number in chronological order, from the proposed rule
  through the final rule.

Two behaviours are worth knowing about:

- **Client-side comment-date filters (labelled).** The API
  publishes no comment-date search condition, so
  `search_documents`' optional `comment_date_gte` /
  `comment_date_lte` arguments are applied locally, after
  the response arrives: documents whose `comments_close_on`
  is null or outside the range are dropped from the
  returned page, and the rest of the response envelope is
  returned unchanged. Every other search result is the
  upstream JSON verbatim.
- **Pacing.** Requests are polite by design: at least
  300 ms pass between request starts, and if the API
  answers HTTP 429 the client waits the `Retry-After`
  interval (60 seconds by default) and retries the same
  request once before reporting an error.

The API base URL defaults to
`https://www.federalregister.gov/api/v1` and can be
overridden with the `FEDERAL_REGISTER_API_BASE`
environment variable.

## CLI

Each tool is a subcommand taking one JSON argument string
(`list_agencies` takes none):

```bash
npx @reneturcios/fedregister search_documents '{"term":"endangered species","type":["PRORULE"],"comment_date_gte":"2026-11-01"}'
npx @reneturcios/fedregister get_document '{"document_number":"2026-12345"}'
npx @reneturcios/fedregister get_documents_batch '{"document_numbers":["2026-12345","2026-12346"]}'
npx @reneturcios/fedregister get_facet_counts '{"facet":"monthly","term":"climate"}'
npx @reneturcios/fedregister get_public_inspection '{"special_filing":true}'
npx @reneturcios/fedregister list_agencies
npx @reneturcios/fedregister open_comment_periods '{"limit":10}'
npx @reneturcios/fedregister far_case_history '{"case_number":"FAR Case 2023-008"}'
npx @reneturcios/fedregister --version
```

Output is the tool's result text (the upstream JSON, or a
composition's JSON). Exit codes: `0` on success, `1` on a
runtime error (including a validation or upstream failure),
`2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/fedregister mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "fedregister": {
      "command": "npx",
      "args": ["-y", "@reneturcios/fedregister", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/fedregister
docker run --rm ghcr.io/cloudcorprecords/fedregister list_agencies
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (fake fetch + fake clock + fake sleep, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios
