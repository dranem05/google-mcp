import { describe, expect, it } from "vitest";
import { escapeDriveQueryValue } from "./drive-query.js";

describe("escapeDriveQueryValue", () => {
  it("escapes a single quote so it can't break out of the q string literal", () => {
    expect(escapeDriveQueryValue("O'Brien's file")).toBe("O\\'Brien\\'s file");
  });

  it("escapes backslashes before quotes so escaping itself can't be escaped", () => {
    expect(escapeDriveQueryValue("back\\slash")).toBe("back\\\\slash");
  });

  it("escapes a value that tries to inject additional query clauses", () => {
    const malicious = "x' or fullText contains '";
    const escaped = escapeDriveQueryValue(malicious);
    expect(escaped).toBe("x\\' or fullText contains \\'");
  });

  it("leaves a plain alphanumeric value untouched", () => {
    expect(escapeDriveQueryValue("1AbCdEf23456")).toBe("1AbCdEf23456");
  });
});
