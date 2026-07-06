import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OAuth2Client } from "google-auth-library";

export interface ServiceContext {
  auth: OAuth2Client;
  /** Account slug (e.g. "jane-acme-com"), used in error hints. Optional so existing callers/tests are unaffected. */
  accountSlug?: string;
}

export type RegisterTools = (server: McpServer, ctx: ServiceContext) => void;
