/**
 * fedregister MCP server. Tools: search_documents,
 * get_document, get_documents_batch, get_facet_counts,
 * get_public_inspection, list_agencies,
 * open_comment_periods, far_case_history.
 *
 * Why the low-level Server instead of McpServer: the
 * high-level helper converts zod schemas to JSON Schema and
 * injects keys that are not in this tool set's documented
 * spec ("$schema" and "additionalProperties"), which breaks
 * exact tool-list/schema parity with the spec. This file
 * serves tools/list with the spec's exact input schemas as
 * explicit literals, and the core validates every tools/call
 * argument set itself.
 *
 * Every tool returns a single text item carrying the
 * upstream JSON (or a composition's JSON); validation and
 * upstream failures come back as isError results carrying
 * the documented error strings.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { FedRegisterClient, VERSION } from "./register.js";

const STRING_ARRAY = { items: { type: "string" }, type: "array", description: "Array of string values for this filter (optional)." } as const;

const TOOLS = [
  {
    name: "search_documents",
    description:
      "Search Federal Register documents published since 1994: rules, proposed rules, notices, presidential documents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agencies: STRING_ARRAY,
        cfr_part: { type: "string" , description: "The cfr part for this call." },
        cfr_title: { type: "integer" , description: "The cfr title for this call." },
        comment_date_gte: { type: "string" , description: "The comment date gte for this call." },
        comment_date_lte: { type: "string" , description: "The comment date lte for this call." },
        docket_id: { type: "string" , description: "Identifier of the docket." },
        effective_date_gte: { type: "string" , description: "The effective date gte for this call." },
        effective_date_is: { type: "string" , description: "The effective date is for this call." },
        effective_date_lte: { type: "string" , description: "The effective date lte for this call." },
        effective_date_year: { type: "integer" , description: "The effective date year for this call." },
        fields: STRING_ARRAY,
        order: {
          enum: ["relevance", "newest", "oldest", "executive_order_number"],
          type: "string",
         description: "The order for this call." },
        page: { type: "integer" , description: "Page number for paginated results (optional)." },
        per_page: { type: "integer" , description: "The per page for this call." },
        publication_date_gte: { type: "string" , description: "The publication date gte for this call." },
        publication_date_is: { type: "string" , description: "The publication date is for this call." },
        publication_date_lte: { type: "string" , description: "The publication date lte for this call." },
        publication_date_year: { type: "integer" , description: "The publication date year for this call." },
        regulation_id_number: { type: "string" , description: "The regulation identifier number for this call." },
        sections: STRING_ARRAY,
        significant: { type: "boolean" , description: "The significant for this call." },
        term: { type: "string" , description: "Search term." },
        topics: STRING_ARRAY,
        type: STRING_ARRAY,
      },
    },
  },
  {
    name: "get_document",
    description: "Fetch a single Federal Register document by document number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        document_number: { type: "string" , description: "The document number for this call." },
        fields: STRING_ARRAY,
      },
      required: ["document_number"],
    },
  },
  {
    name: "get_documents_batch",
    description:
      "Fetch multiple Federal Register documents in one call (up to 20 document numbers).",
    inputSchema: {
      type: "object" as const,
      properties: {
        document_numbers: STRING_ARRAY,
      },
      required: ["document_numbers"],
    },
  },
  {
    name: "get_facet_counts",
    description:
      "Counts of matching documents grouped by a facet (a document field or a time bucket).",
    inputSchema: {
      type: "object" as const,
      properties: {
        agencies: STRING_ARRAY,
        cfr_part: { type: "string" , description: "The cfr part for this call." },
        cfr_title: { type: "integer" , description: "The cfr title for this call." },
        docket_id: { type: "string" , description: "Identifier of the docket." },
        facet: { type: "string" , description: "The facet for this call." },
        publication_date_gte: { type: "string" , description: "The publication date gte for this call." },
        publication_date_lte: { type: "string" , description: "The publication date lte for this call." },
        regulation_id_number: { type: "string" , description: "The regulation identifier number for this call." },
        significant: { type: "boolean" , description: "The significant for this call." },
        term: { type: "string" , description: "Search term." },
        type: STRING_ARRAY,
      },
      required: ["facet"],
    },
  },
  {
    name: "get_public_inspection",
    description: "Search documents currently on public inspection (pre-publication).",
    inputSchema: {
      type: "object" as const,
      properties: {
        agencies: STRING_ARRAY,
        available_on: { type: "string" , description: "The available on for this call." },
        docket_id: { type: "string" , description: "Identifier of the docket." },
        fields: STRING_ARRAY,
        page: { type: "integer" , description: "Page number for paginated results (optional)." },
        per_page: { type: "integer" , description: "The per page for this call." },
        special_filing: { type: "boolean" , description: "The special filing for this call." },
        term: { type: "string" , description: "Search term." },
        type: STRING_ARRAY,
      },
    },
  },
  {
    name: "list_agencies",
    description: "All Federal Register agencies.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "open_comment_periods",
    description:
      "Proposed rules and notices whose comment period is still open, sorted by deadline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agencies: STRING_ARRAY,
        limit: { type: "integer" , description: "Maximum number of results to return (optional)." },
        term: { type: "string" , description: "Search term." },
      },
    },
  },
  {
    name: "far_case_history",
    description:
      "The full document history of a FAR/DFARS case, from the proposed rule to the final rule.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string" , description: "The case number for this call." },
      },
      required: ["case_number"],
    },
  },
];

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

// One shared client, so the 300 ms pacing holds across calls.
const client = new FedRegisterClient();

const server = new Server(
  { name: "fedregister", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let out: string;
    switch (name) {
      case "search_documents":
        out = await client.searchDocuments(a as never);
        break;
      case "get_document":
        out = await client.getDocument(a as never);
        break;
      case "get_documents_batch":
        out = await client.getDocumentsBatch(a as never);
        break;
      case "get_facet_counts":
        out = await client.getFacetCounts(a as never);
        break;
      case "get_public_inspection":
        out = await client.getPublicInspection(a as never);
        break;
      case "list_agencies":
        out = await client.listAgencies();
        break;
      case "open_comment_periods":
        out = await client.openCommentPeriods(a as never);
        break;
      case "far_case_history":
        out = await client.farCaseHistory(a as never);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(out);
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
