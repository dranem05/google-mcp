import { describe, expect, it } from "vitest";
import { mapGoogleError, isInsufficientScopeError, describeMissingScopeError } from "./errors.js";

describe("mapGoogleError", () => {
  it("formats a standard Google API error with HTTP status and message", () => {
    const error = {
      message: "File not found: abc123",
      response: {
        status: 404,
        data: {
          error: {
            code: 404,
            message: "File not found: abc123",
            status: "NOT_FOUND",
          },
        },
      },
    };

    expect(mapGoogleError(error)).toBe("HTTP 404 — File not found: abc123");
  });

  it("joins per-item error messages when the API returns an errors array", () => {
    const error = {
      message: "Invalid request",
      response: {
        status: 400,
        data: {
          error: {
            code: 400,
            message: "Invalid request",
            errors: [
              { domain: "global", reason: "invalid", message: "Bad range specified" },
            ],
          },
        },
      },
    };

    expect(mapGoogleError(error)).toBe("HTTP 400 — Bad range specified");
  });

  it("special-cases invalid_grant with a hint to re-run bootstrap", () => {
    const error = {
      message: "invalid_grant",
      response: {
        status: 400,
        data: {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
      },
    };

    const result = mapGoogleError(error, { accountSlug: "jane-acme-com" });

    expect(result).toContain("invalid_grant");
    expect(result).toContain("Token has been expired or revoked.");
    expect(result).toContain(
      "refresh token expired/revoked — run bootstrap/lib/add-google-account.sh jane-acme-com"
    );
  });

  it("falls back to a generic hint when no account slug is available", () => {
    const error = {
      message: "invalid_grant",
      response: {
        status: 400,
        data: { error: "invalid_grant" },
      },
    };

    expect(mapGoogleError(error)).toContain(
      "run bootstrap/lib/add-google-account.sh <account email>"
    );
  });

  it("special-cases 403 rate-limit / quota errors with a retried-automatically note", () => {
    const error = {
      message: "User Rate Limit Exceeded",
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "User Rate Limit Exceeded",
            errors: [
              { domain: "usageLimits", reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded" },
            ],
          },
        },
      },
    };

    const result = mapGoogleError(error);
    expect(result).toContain("HTTP 403");
    expect(result).toContain("User Rate Limit Exceeded");
    expect(result).toContain("retried automatically; still failing");
  });

  it("does not add the quota note for a 403 that is not rate/quota related", () => {
    const error = {
      message: "Forbidden",
      response: {
        status: 403,
        data: {
          error: { code: 403, message: "The caller does not have permission" },
        },
      },
    };

    expect(mapGoogleError(error)).not.toContain("retried automatically");
  });

  it("falls back to err.message for a plain Error with no response", () => {
    expect(mapGoogleError(new Error("boom"))).toBe("boom");
  });

  it("handles non-Error, non-object values without throwing", () => {
    expect(mapGoogleError("just a string")).toBe("just a string");
    expect(mapGoogleError(undefined)).toBe("Unknown error");
  });
});

describe("isInsufficientScopeError", () => {
  it("is true for a 403 with Google's insufficient-scope message", () => {
    const error = {
      message: "Insufficient Permission",
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            status: "PERMISSION_DENIED",
          },
        },
      },
    };
    expect(isInsufficientScopeError(error)).toBe(true);
  });

  it("is false for an unrelated 403 (e.g. an ACL/ownership permission error)", () => {
    const error = {
      message: "Forbidden",
      response: {
        status: 403,
        data: { error: { code: 403, message: "The caller does not have permission" } },
      },
    };
    expect(isInsufficientScopeError(error)).toBe(false);
  });

  it("is false for a non-403 error even if it mentions scopes", () => {
    const error = {
      message: "Request had insufficient authentication scopes.",
      response: { status: 401, data: { error: { code: 401, message: "Request had insufficient authentication scopes." } } },
    };
    expect(isInsufficientScopeError(error)).toBe(false);
  });

  it("handles non-Error, non-object values without throwing", () => {
    expect(isInsufficientScopeError("just a string")).toBe(false);
    expect(isInsufficientScopeError(undefined)).toBe(false);
  });
});

describe("describeMissingScopeError", () => {
  it("names the missing scope and the re-auth command for the given account", () => {
    const message = describeMissingScopeError("https://www.googleapis.com/auth/gmail.settings.basic", {
      accountSlug: "jane-acme-com",
    });
    expect(message).toContain("https://www.googleapis.com/auth/gmail.settings.basic");
    expect(message).toContain("bootstrap/lib/add-google-account.sh jane-acme-com");
    expect(message).toMatch(/restart/i);
  });

  it("falls back to a generic account placeholder when no slug is available", () => {
    const message = describeMissingScopeError("https://www.googleapis.com/auth/gmail.settings.basic");
    expect(message).toContain("bootstrap/lib/add-google-account.sh <account email>");
  });
});
