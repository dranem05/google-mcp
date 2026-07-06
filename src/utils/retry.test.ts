import { describe, expect, it, vi } from "vitest";
import { parseRetryAfterMs } from "./retry.js";

describe("parseRetryAfterMs", () => {
  it("returns null when there is no header", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
  });

  it("parses delta-seconds form", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses an HTTP-date form relative to now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:30 GMT")).toBe(30_000);

    vi.useRealTimers();
  });

  it("clamps a past HTTP-date to 0 instead of a negative delay", () => {
    const now = new Date("2026-01-01T00:00:30.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:00 GMT")).toBe(0);

    vi.useRealTimers();
  });

  it("returns null for unparsable values", () => {
    expect(parseRetryAfterMs("not-a-valid-value")).toBeNull();
  });
});
