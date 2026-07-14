#!/usr/bin/env node
/**
 * Stdio entrypoint for IDE / local MCP (Cursor mcp.json).
 * stdout is the JSON-RPC channel — only log to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPrReviewerServer } from "./serverFactory.js";

async function main(): Promise<void> {
  const server = createPrReviewerServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pr-god] server running on stdio; waiting for JSON-RPC requests.");
}

main().catch((err) => {
  console.error("[pr-god] fatal error starting server:", err);
  process.exit(1);
});
