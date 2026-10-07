import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { isZeroParamObject, newStrictifyStats, strictifyRegisteredSchema, type StrictifyStats } from "./strict-params.js";

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
const INSUFFICIENT_SCOPE_PATTERN = /insufficient authentication scopes/i;

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

/**
 * True if the given error is a Google API 403 caused specifically by the
 * OAuth grant lacking a required scope, as opposed to e.g. an ACL/ownership
 * 403. Google reports this as HTTP 403 with the literal message
 * "Request had insufficient authentication scopes." — same shape covered by
 * `meet_create_link`'s documented scope requirement.
 */
export function isInsufficientScopeError(error: unknown): boolean {
  if (!(error instanceof Error) && (typeof error !== "object" || error === null)) return false;
  const err = error as GaxiosLikeError & Error;
  if (err.response?.status !== 403) return false;
  const apiError = err.response?.data?.error;
  const message = (typeof apiError === "string" ? apiError : apiError?.message) ?? err.message ?? "";
  return INSUFFICIENT_SCOPE_PATTERN.test(message);
}

/**
 * Builds a friendly, actionable message for a scope-insufficient 403: names
 * the specific missing scope and points at the re-auth fix, instead of the
 * generic "insufficient authentication scopes" Google returns. Callers should
 * only use this after confirming `isInsufficientScopeError`.
 */
export function describeMissingScopeError(scope: string, opts: MapGoogleErrorOptions = {}): string {
  const account = opts.accountSlug ?? "<account email>";
  return (
    `This requires the "${scope}" OAuth scope, which this account's current grant does not have. ` +
    `Add it to the scope list and re-run bootstrap/lib/add-google-account.sh ${account} to re-authorize, then restart the MCP server.`
  );
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
    try {
      registered.inputSchema = strictifyRegisteredSchema(args[0], registered.inputSchema, stats);
    } catch (error) {
      // The SDK has already registered the tool with its loose default schema;
      // never leave that behind when strictification refuses.
      registered.remove();
      throw error;
    }
    return registered;
  };
}

/** Per-server strictify coverage, for startup assertions and tests. */
export const strictifyStats = new WeakMap<McpServer, StrictifyStats>();

/**
 * Startup invariant: every registered tool either takes no arguments at all
 * (no schema, or an object with no properties, which stays lenient on purpose)
 * or has a strict top-level input schema. A top-level object that declares a
 * catchall is accepted: `never` is what the choke point installs, and any other
 * catchall (`.passthrough()` / `looseObject` / `.catchall(x)`) is a deliberate
 * opt-out that `deepStrict` also leaves alone, so the two policies agree.
 * Catches any registration that bypassed the patched `server.tool` (e.g. a
 * future direct `registerTool` call). Throws, so a violation fails at startup,
 * not per call.
 */
export function assertToolsStrict(server: McpServer): { strict: number; noArgs: number } {
  // `_registeredTools` is a private SDK field; fail clearly if an SDK upgrade moves it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { inputSchema?: any }> | undefined;
  if (tools === undefined || tools === null || typeof tools !== "object") {
    throw new Error(
      "strict-params: McpServer._registeredTools (private SDK internal) is missing; the installed " +
        "@modelcontextprotocol/sdk no longer matches what assertToolsStrict expects"
    );
  }
  let strict = 0;
  let noArgs = 0;
  const offenders: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const def = tool.inputSchema?._zod?.def;
    if (tool.inputSchema === undefined || isZeroParamObject(def)) noArgs++;
    else if (def?.type === "object" && def.catchall !== undefined) strict++;
    else offenders.push(name);
  }
  if (offenders.length > 0) {
    throw new Error(`strict-params: tools registered without strict input schemas: ${offenders.join(", ")}`);
  }
  return { strict, noArgs };
}
