import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { newStrictifyStats, strictifyRegisteredSchema, type StrictifyStats } from "./strict-params.js";

/** Shape of the pieces of a GaxiosError we read. Duck-typed so tests don't need a real GaxiosError. */
interface GaxiosLikeError {
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            message?: string;
            code?: number;
            status?: string;
            errors?: Array<{ message?: string; reason?: string; domain?: string }>;
          };
      error_description?: string;
    };
  };
}

export interface MapGoogleErrorOptions {
  /** The google-mcp account slug (e.g. "jane-acme-com"), used in the invalid_grant hint. */
  accountSlug?: string;
}

const RATE_OR_QUOTA_PATTERN = /rate.?limit|quota/i;

/**
 * Turns a thrown error (typically a GaxiosError from a Google API call) into a
 * human-readable string: HTTP status + the Google API error message, with
 * special-cased hints for expired auth and rate/quota errors.
 */
export function mapGoogleError(error: unknown, opts: MapGoogleErrorOptions = {}): string {
  if (!(error instanceof Error) && (typeof error !== "object" || error === null)) {
    return error === undefined || error === null ? "Unknown error" : String(error);
  }

  const err = error as GaxiosLikeError & Error;
  const apiError = err.response?.data?.error;
  const httpStatus = err.response?.status;

  let message: string | undefined;
  const reasons: string[] = [];

  if (typeof apiError === "string") {
    message = err.response?.data?.error_description
      ? `${apiError}: ${err.response.data.error_description}`
      : apiError;
  } else if (apiError && typeof apiError === "object") {
    if (Array.isArray(apiError.errors) && apiError.errors.length > 0) {
      const perItemMessages = apiError.errors.map((e) => e.message).filter(Boolean) as string[];
      if (perItemMessages.length > 0) message = perItemMessages.join("; ");
      for (const e of apiError.errors) {
        if (e.reason) reasons.push(e.reason);
      }
    }
    if (!message) message = apiError.message;
  }

  if (!message) message = err.message || "Unknown error";

  const parts: string[] = [];
  parts.push(httpStatus ? `HTTP ${httpStatus} — ${message}` : message);

  const rawErrorIsInvalidGrant = typeof apiError === "string" && apiError === "invalid_grant";
  const isInvalidGrant = rawErrorIsInvalidGrant || err.message === "invalid_grant";
  if (isInvalidGrant) {
    const account = opts.accountSlug ?? "<account email>";
    parts.push(
      `refresh token expired/revoked — run bootstrap/lib/add-google-account.sh ${account}`
    );
  }

  const isQuotaOrRate =
    httpStatus === 403 &&
    (RATE_OR_QUOTA_PATTERN.test(message) || reasons.some((r) => RATE_OR_QUOTA_PATTERN.test(r)));
  if (isQuotaOrRate) {
    parts.push("retried automatically; still failing");
  }

  return parts.join(" — ");
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolCallback = (...args: any[]) => any;

/**
 * Wraps a tool handler so that any thrown error (Google API failures in
 * particular) is caught and turned into a readable MCP error result instead
 * of an unhandled rejection or a raw stack trace.
 */
export function wrapTool<T extends AnyToolCallback>(handler: T, opts: MapGoogleErrorOptions = {}): T {
  const wrapped = async (...args: Parameters<T>): Promise<CallToolResult> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof McpError) throw error;
      return errorResult(mapGoogleError(error, opts));
    }
  };
  return wrapped as T;
}

/**
 * Single choke point: patches `server.tool` so every tool registered from
 * here on (across all services) has its handler wrapped with `wrapTool`,
 * without needing to touch each of the individual tool registrations.
 */
export function installToolErrorHandling(server: McpServer, opts: MapGoogleErrorOptions = {}): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = server.tool.bind(server) as (...args: any[]) => any;
  const stats = newStrictifyStats();
  strictifyStats.set(server, stats);
  // `tool` has many overloads but the callback is always the last argument.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: any[]) => {
    const lastIndex = args.length - 1;
    if (typeof args[lastIndex] === "function") {
      args[lastIndex] = wrapTool(args[lastIndex], opts);
    }
    // Let the SDK resolve its own overloads (description / raw shape /
    // annotations, in any combination), then make the schema it built strict.
    // Post-processing the RegisteredTool avoids re-implementing the overload
    // parsing here, which is where a choke point could mis-register silently.
    const registered = original(...args);
    registered.inputSchema = strictifyRegisteredSchema(args[0], registered.inputSchema, stats);
    return registered;
  };
}

/** Per-server strictify coverage, for startup assertions and tests. */
export const strictifyStats = new WeakMap<McpServer, StrictifyStats>();

/**
 * Startup invariant: every registered tool either takes no arguments at all or
 * has a strict (unknown-keys-rejecting) top-level input schema. Catches any
 * registration that bypassed the patched `server.tool` (e.g. a future direct
 * `registerTool` call). Throws, so a violation fails at startup, not per call.
 */
export function assertToolsStrict(server: McpServer): { strict: number; noArgs: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { inputSchema?: any }>;
  let strict = 0;
  let noArgs = 0;
  const offenders: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const def = tool.inputSchema?._zod?.def;
    if (tool.inputSchema === undefined) noArgs++;
    else if (def?.type === "object" && def.catchall?._zod?.def?.type === "never") strict++;
    else offenders.push(name);
  }
  if (offenders.length > 0) {
    throw new Error(`strict-params: tools registered without strict input schemas: ${offenders.join(", ")}`);
  }
  return { strict, noArgs };
}
