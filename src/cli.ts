#!/usr/bin/env node
/**
 * fedregister CLI.
 *
 *   fedregister search_documents '<json>'
 *   fedregister get_document '<json>'
 *   fedregister get_documents_batch '<json>'
 *   fedregister get_facet_counts '<json>'
 *   fedregister get_public_inspection '<json>'
 *   fedregister list_agencies
 *   fedregister open_comment_periods '<json>'
 *   fedregister far_case_history '<json>'
 *   fedregister mcp
 *   fedregister --version
 *
 * Each tool subcommand takes one JSON argument string with
 * the tool's arguments (list_agencies takes none) and prints
 * the tool's result text. Exit codes: 0 success, 1 runtime
 * error, 2 usage error.
 */
import { FedRegisterClient, VERSION } from "./register.js";

const TOOL_NAMES = [
  "search_documents",
  "get_document",
  "get_documents_batch",
  "get_facet_counts",
  "get_public_inspection",
  "list_agencies",
  "open_comment_periods",
  "far_case_history",
] as const;

const client = new FedRegisterClient();

function usage(): never {
  console.error(`Usage:
  fedregister <tool> '<json-args>'     one of: ${TOOL_NAMES.join(", ")} (list_agencies takes no argument)
  fedregister mcp
  fedregister --version`);
  process.exit(2);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "search_documents":
      return client.searchDocuments(args as never);
    case "get_document":
      return client.getDocument(args as never);
    case "get_documents_batch":
      return client.getDocumentsBatch(args as never);
    case "get_facet_counts":
      return client.getFacetCounts(args as never);
    case "get_public_inspection":
      return client.getPublicInspection(args as never);
    case "list_agencies":
      return client.listAgencies();
    case "open_comment_periods":
      return client.openCommentPeriods(args as never);
    case "far_case_history":
      return client.farCaseHistory(args as never);
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!(TOOL_NAMES as readonly string[]).includes(cmd ?? "")) usage();
  if (cmd === "list_agencies") {
    if (rest.length !== 0) usage();
  } else if (rest.length > 1) {
    usage();
  }
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  try {
    const out = await runTool(cmd, args);
    console.log(out);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
