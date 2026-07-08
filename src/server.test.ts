import { describe, expect, it } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, parseFamilies, TOOL_FAMILIES } from "./server.js";

/** Tool names registered on an McpServer, via the SDK's internal registry. */
function registeredToolNames(server: McpServer): string[] {
  return Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  );
}

function makeCtx() {
  return { auth: new OAuth2Client(), accountSlug: "test-slug" };
}

describe("parseFamilies", () => {
  it("parses a comma-separated list, trimming whitespace", () => {
    expect(parseFamilies("gmail, calendar,drive")).toEqual(["gmail", "calendar", "drive"]);
  });

  it("deduplicates repeated families", () => {
    expect(parseFamilies("gmail,gmail,calendar")).toEqual(["gmail", "calendar"]);
  });

  it("accepts every valid family", () => {
    expect(parseFamilies(TOOL_FAMILIES.join(","))).toEqual([...TOOL_FAMILIES]);
  });

  it("fails fast on an unknown family, naming it and listing the valid ones", () => {
    expect(() => parseFamilies("gmail,frobnicate")).toThrow(/frobnicate/);
    expect(() => parseFamilies("gmail,frobnicate")).toThrow(
      /gmail, calendar, meet, drive, docs, sheets, slides/
    );
  });

  it("fails fast on an empty list", () => {
    expect(() => parseFamilies("")).toThrow(/gmail, calendar, meet, drive, docs, sheets, slides/);
    expect(() => parseFamilies(" , ")).toThrow(
      /gmail, calendar, meet, drive, docs, sheets, slides/
    );
  });
});

describe("createServer families filtering", () => {
  it("registers every family by default (flag absent)", () => {
    const names = registeredToolNames(createServer(makeCtx()));

    for (const family of TOOL_FAMILIES) {
      expect(
        names.some((n) => n.startsWith(`${family}_`)),
        `expected at least one ${family}_* tool`
      ).toBe(true);
    }
  });

  it("registers only the listed families", () => {
    const names = registeredToolNames(
      createServer(makeCtx(), { families: ["gmail", "calendar"] })
    );

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith("gmail_") || n.startsWith("calendar_"))).toBe(true);
    expect(names.some((n) => n.startsWith("gmail_"))).toBe(true);
    expect(names.some((n) => n.startsWith("calendar_"))).toBe(true);
  });

  it("registers a single family", () => {
    const names = registeredToolNames(createServer(makeCtx(), { families: ["drive"] }));

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith("drive_"))).toBe(true);
  });

  it("matches the default registration exactly when all families are listed", () => {
    const defaultNames = registeredToolNames(createServer(makeCtx()));
    const allNames = registeredToolNames(
      createServer(makeCtx(), { families: [...TOOL_FAMILIES] })
    );

    expect(allNames).toEqual(defaultNames);
  });
});
