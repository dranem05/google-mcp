import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegisterTools, ServiceContext } from "./types.js";
import { installToolErrorHandling } from "./utils/errors.js";
import { registerGmailTools } from "./services/gmail/index.js";
import { registerCalendarTools } from "./services/calendar/index.js";
import { registerMeetTools } from "./services/meet/index.js";
import { registerDriveTools } from "./services/drive/index.js";
import { registerDocsTools } from "./services/docs/index.js";
import { registerSheetsTools } from "./services/sheets/index.js";
import { registerSlidesTools } from "./services/slides/index.js";

/** Every tool family, in registration order. Family = the tool-name prefix. */
export const TOOL_FAMILIES = [
  "gmail",
  "calendar",
  "meet",
  "drive",
  "docs",
  "sheets",
  "slides",
] as const;

export type ToolFamily = (typeof TOOL_FAMILIES)[number];

const FAMILY_REGISTRARS: Record<ToolFamily, RegisterTools> = {
  gmail: registerGmailTools,
  calendar: registerCalendarTools,
  meet: registerMeetTools,
  drive: registerDriveTools,
  docs: registerDocsTools,
  sheets: registerSheetsTools,
  slides: registerSlidesTools,
};

/**
 * Parses a --families value ("gmail,calendar") into a deduplicated list of
 * valid families, failing fast on anything unknown or an empty list.
 */
export function parseFamilies(spec: string): ToolFamily[] {
  const names = spec
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const valid = TOOL_FAMILIES.join(", ");
  if (names.length === 0) {
    throw new Error(`--families requires at least one family. Valid families: ${valid}`);
  }

  const families: ToolFamily[] = [];
  for (const name of names) {
    if (!(TOOL_FAMILIES as readonly string[]).includes(name)) {
      throw new Error(`Unknown tool family "${name}". Valid families: ${valid}`);
    }
    if (!families.includes(name as ToolFamily)) {
      families.push(name as ToolFamily);
    }
  }
  return families;
}

export interface CreateServerOptions {
  /** Tool families to register. Defaults to all of them. */
  families?: readonly ToolFamily[];
}

export function createServer(ctx: ServiceContext, opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "google-mcp",
    version: "0.1.0",
  });

  // Choke point: every server.tool(...) call made by the register*Tools
  // functions below gets its handler wrapped with Google API error mapping,
  // without editing each of the ~120 individual tool handlers.
  installToolErrorHandling(server, { accountSlug: ctx.accountSlug });

  for (const family of opts.families ?? TOOL_FAMILIES) {
    FAMILY_REGISTRARS[family](server, ctx);
  }

  return server;
}
