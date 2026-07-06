#!/usr/bin/env node
import { program } from "commander";
import { google } from "googleapis";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAuth } from "./auth.js";
import { createServer } from "./server.js";
import { buildRetryConfig } from "./utils/retry.js";
import { homedir } from "node:os";
import { join } from "node:path";

// This process is one of several long-lived MCP servers driving a live
// Claude session. A stray unhandled *rejection* (typically a fire-and-forget
// Google API call) must not take the session down — log it and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[google-mcp] Unhandled promise rejection:", reason);
});
// An uncaught *exception* is different: Node's own state may be corrupt, and
// swallowing it would also mask genuine startup failures (e.g. a missing
// credentials file, or a top-level-await rejection from server.connect) by
// turning them into a silent exit code 0. Log it, then exit non-zero so the
// MCP host sees the failure and can surface/restart it.
process.on("uncaughtException", (error) => {
  console.error("[google-mcp] Uncaught exception:", error);
  process.exit(1);
});

// Retry 429s and 5xx errors up to 3 times across every googleapis client,
// honoring Retry-After when the server sends one.
google.options({ retryConfig: buildRetryConfig() });

program
  .name("google-mcp")
  .description("Consolidated Google MCP server")
  .requiredOption("--slug <slug>", "Google account slug (e.g. jane-acme-com)")
  .option(
    "--token-dir <dir>",
    "Directory containing credentials files",
    join(homedir(), ".config", "openbrain", "tokens")
  )
  .parse();

const opts = program.opts<{ slug: string; tokenDir: string }>();

// The parent (Claude Code) terminates stdio MCP servers with SIGINT/SIGTERM
// during session teardown. Without these handlers gVisor (Cloud Run's sandbox)
// reports each as `Uncaught signal: 2` at ERROR severity in Cloud Logging.
const shutdown = (): never => process.exit(0);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const auth = loadAuth(opts.slug, opts.tokenDir);
const server = createServer({ auth, accountSlug: opts.slug });
const transport = new StdioServerTransport();
await server.connect(transport);
