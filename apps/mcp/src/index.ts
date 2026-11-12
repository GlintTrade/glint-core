// Entry point: the Glint MCP server over stdio.
// stdout carries the MCP protocol: logs go to stderr only.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME} ${SERVER_VERSION}] ready: api=${cfg.apiUrl} web=${cfg.webUrl} apiKey=${cfg.apiKey ? "set" : "NOT SET"}`);
}

main().catch((e) => {
  console.error(`[${SERVER_NAME}] fatal:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
