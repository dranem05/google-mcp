import type { GoogleApis } from "googleapis";

// Derive the retry config type from googleapis' own `google.options()` param
// rather than importing gaxios' types directly: googleapis vendors gaxios
// via a mix of ESM/CJS resolution, and importing the same class from both
// places makes TypeScript see two structurally-incompatible `GaxiosError`
// types. Going through `GoogleApis` keeps a single consistent type source.
type GlobalOptions = NonNullable<Parameters<GoogleApis["options"]>[0]>;
type RetryConfig = NonNullable<GlobalOptions["retryConfig"]>;
type RetryBackoff = NonNullable<RetryConfig["retryBackoff"]>;
type BackoffError = Parameters<RetryBackoff>[0];

/**
 * Parses a `Retry-After` header value into a millisecond delay.
 * Supports both the delta-seconds form ("120") and the HTTP-date form
 * ("Thu, 01 Jan 2026 00:00:30 GMT"). Returns null when the header is
 * missing or unparsable.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

/**
 * Global gaxios retry config: retry 429s and 5xxs up to 3 times, honoring
 * the server's `Retry-After` header when present instead of blind
 * exponential backoff.
 */
export function buildRetryConfig(): RetryConfig {
  return {
    retry: 3,
    statusCodesToRetry: [
      [429, 429],
      [500, 599],
    ],
    retryBackoff: async (err: BackoffError, defaultBackoffMs: number) => {
      const retryAfterMs = parseRetryAfterMs(err.response?.headers?.get?.("retry-after"));
      const delayMs = retryAfterMs ?? defaultBackoffMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
  };
}
