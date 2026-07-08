#!/usr/bin/env node
import { program } from "commander";
import { google } from "googleapis";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAuth, loadEnvTokenAuth } from "./auth.js";
import { resolveAuthMode, type AuthMode } from "./cli.js";
import { createServer, parseFamilies, ToolFamily } from "./server.js";
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
  .option(
    "--slug <slug>",
    "Google account slug (e.g. jane-acme-com); required unless --access-token-env is used"
  )
  .option(
    "--token-dir <dir>",
    "Directory containing credentials files",
    join(homedir(), ".config", "openbrain", "tokens")
  )
  .option(
    "--access-token-env [var]",
    "Hosted mode: read a ready-to-use access token from this environment variable " +
      "(default GOOGLE_ACCESS_TOKEN) instead of a credentials file. No refresh, nothing " +
      "is read from or written to disk; the host owns the token lifecycle."
  )
  .option(
    "--families <list>",
    "Comma-separated tool families to register (default: all). " +
      "Valid: gmail, calendar, meet, drive, docs, sheets, slides"
  )
  .parse();

const opts = program.opts<{
  slug?: string;
  tokenDir: string;
  accessTokenEnv?: string | boolean;
  families?: string;
}>();

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  // program.error prints to stderr and exits 1, matching what commander's own
  // arg validation (e.g. the old requiredOption --slug) did before.
  return program.error(`error: ${message}`);
}

let authMode: AuthMode;
let families: ToolFamily[] | undefined;
try {
  authMode = resolveAuthMode(opts, program.getOptionValueSource("tokenDir"));
  families = opts.families === undefined ? undefined : parseFamilies(opts.families);
} catch (error) {
  fail(error);
}

// The parent (Claude Code) terminates stdio MCP servers with SIGINT/SIGTERM
// during session teardown. Without these handlers gVisor (Cloud Run's sandbox)
// reports each as `Uncaught signal: 2` at ERROR severity in Cloud Logging.
const shutdown = (): never => process.exit(0);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const auth =
  authMode.mode === "env-token"
    ? loadEnvTokenAuth(authMode.envVar)
    : loadAuth(authMode.slug, authMode.tokenDir);
const server = createServer({ auth, accountSlug: authMode.slug }, { families });
const transport = new StdioServerTransport();
await server.connect(transport);
