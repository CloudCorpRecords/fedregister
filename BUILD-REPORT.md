# fedregister — Build Report (Batch 22)

Rebuild of the `federal-register-mcp` MCP server (PyPI
v1.0.20; registry record
`com.1102tools/federal-register-mcp`) from the firsthand
spec in `specs-batch22/fedregister.md`. Built 2026-10-27.

## Identity

- npm: `@reneturcios/fedregister` @ 0.1.0, bin
  `fedregister` → `dist/cli.js`
- MCP Registry name: `io.github.CloudCorpRecords/fedregister`
  (matches `package.json` `mcpName`, `server.json` `name`,
  and the Dockerfile `io.modelcontextprotocol.server.name`
  label)
- server.json description (92 chars, verified):
  "Search the Federal Register: rules, notices, executive
  orders, comment deadlines, FAR cases."
- server.json: npm package entry carries `"version":
  "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/fedregister:0.1.0`) carries
  **no** `version` field (verified).

## Files (19-file factory set, per TEMPLATE.md §2)

package.json, server.json, Dockerfile, tsconfig.json
(copied unchanged from builds/fairdraw), .gitignore,
package-lock.json, README.md (fresh prose), LICENSE (MIT,
© 2026 Rene Turcios), CHANGELOG.md (single 0.1.0 entry
dated 2026-10-27), src/index.ts, src/cli.ts, src/mcp.ts,
src/types.ts, src/register.ts (core),
test/register.test.ts, and the four workflows under
.github/workflows/ (publish-container adapted: IMAGE
ghcr.io/cloudcorprecords/fedregister, smoke assertion on
server name `fedregister`). Plus this BUILD-REPORT.md and
the parity-out/ artifacts.

## Implementation

- `src/mcp.ts`: low-level `Server` API
  (`sdk/server/index.js` + `StdioServerTransport`,
  handlers for `ListToolsRequestSchema` /
  `CallToolRequestSchema` from `sdk/types.js`), explicit
  JSON-schema literals for all 8 tools (search_documents,
  get_document, get_documents_batch, get_facet_counts,
  get_public_inspection, list_agencies,
  open_comment_periods, far_case_history); no
  McpServer/zod registration. Tool descriptions, property
  types, and `required` lists are the fixture's, exactly.
  The server keeps one shared client so pacing holds
  across calls.
- `src/register.ts`: keyless Federal Register API v1
  client (base default
  `https://www.federalregister.gov/api/v1`, env
  `FEDERAL_REGISTER_API_BASE`, injectable). Flat args map
  to the OpenAPI `conditions[...]` parameters exactly as
  the spec's table states: scalars →
  `conditions[<name>]`; arrays repeat as
  `conditions[<name>][]`; `cfr_title`/`cfr_part` nest
  under `conditions[cfr][...]`; publication/effective
  dates nest under
  `conditions[publication_date|effective_date][is|year|gte|lte]`;
  `significant` / `special_filing` booleans become
  "1"/"0"; `fields` repeats as `fields[]`. Success
  returns the upstream JSON verbatim except for the named
  filters/compositions below.
  - **Client-side filters (labelled):**
    `comment_date_gte` / `comment_date_lte` on
    search_documents are never sent upstream (the API
    publishes no such condition); the returned page is
    filtered on each document's `comments_close_on`
    (null or out-of-range documents dropped, the rest of
    the envelope unchanged).
  - **Compositions (labelled):**
    `open_comment_periods` pages /documents.json with
    `conditions[publication_date][gte]` = 120 days before
    today (scan window), per_page 1000, order newest, at
    most 5 pages, plus the caller's term/agencies; keeps
    `comments_close_on` >= today (injectable clock),
    sorts ascending by `comments_close_on`, applies
    `limit` (default 50), and returns
    `{results, complete, truncated}` — complete when
    every page of the scan window was read, truncated
    when results were cut by limit.
    `far_case_history` is a term search for the case
    number with per_page 1000 and order=oldest, returned
    verbatim.
  - **Pacing (spec-pinned):** a shared pacer enforces
    ≥300 ms between request starts via the injectable
    sleep; on HTTP 429 it waits `Retry-After` seconds
    (default 60) and retries the same request ONCE.
  - Validation before any request, with the spec's exact
    strings: `document_number must be a non-empty string`,
    `document_numbers must be an array of 1 to 20 document
    numbers`, `facet must be a non-empty string`,
    `case_number must be a non-empty string`,
    `per_page must be an integer between 1 and 1000` when
    given. Upstream non-2xx after the retry →
    `federal register error: HTTP <status>`; a throwing
    fetch → `federal register unreachable`. All upstream
    access goes through the injectable fetch; clock and
    sleep are injectable too.
- CLI: one subcommand per tool taking a JSON argument
  string (`list_agencies` takes none), `mcp`,
  `--version`; unknown subcommand → usage on stderr,
  exit 2; isError results exit 1.

## Verification (all real, run 2026-10-27)

- `npm run build` (tsc): exit 0. `npx tsc --noEmit`:
  exit 0.
- `npm test`: **27 tests, 27 pass, 0 fail** — fake fetch +
  fake clock + fake sleep only, no live network, no real
  pacing waits. Covers the full conditions mapping
  (arrays, CFR nesting, date nesting, significant "1"/"0",
  fields[], paging/order), verbatim returns, the
  client-side comment-date filter (null / below / above
  range, envelope preserved), document and batch URL
  shapes, every validation message (with no-request
  assertions), facet and public-inspection mappings,
  list_agencies URL, pacing (300 ms recorded between
  request starts on a shared client), 429 handling
  (Retry-After honoured, 60 s default, single retry then
  HTTP 429 error), HTTP-error and unreachable mapping,
  open_comment_periods (120-day window start
  2026-06-29 for the fixed test clock, keep/sort,
  complete on full scan, truncated on limit,
  complete=false at the 5-page cap), and far_case_history
  (term/per_page/order, verbatim return, validation).
- `node dist/cli.js --version`: `0.1.0`; unknown command:
  usage on stderr, exit 2; a validation failure via the
  CLI exits 1 with the pinned error text.
- Parity: `python3 harness/parity.py --original
  harness/fixtures/federal-register-mcp-tools-original.json
  --rebuild "stdio:node builds/fedregister/dist/cli.js mcp"
  --out builds/fedregister/parity-out` →
  **verdict=PASS parity_pct=100.0, 8/8 tools identical,
  no schema diffs**.
- Lockfile: Route 3 only — clean temp dir with
  package.json alone, `npm install --package-lock-only
  --ignore-scripts --offline`; parses, name
  `@reneturcios/fedregister`, **128 package entries**.
  Dependencies installed in the build dir with
  `npm install --offline --ignore-scripts` (exit 0).

## Gap notes

- No live Federal Register call was made; behaviour is
  proven against fake fetch/clock/sleep only, per spec.
- `open_comment_periods` completeness relies on the
  upstream envelope's `total_pages` when present (with a
  short-page fallback); the 120-day scan window and the
  5-page cap are the spec's labelled local choices.
- No push, no publish.
