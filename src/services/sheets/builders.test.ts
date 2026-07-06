import { describe, expect, it } from "vitest";
import {
  buildFindReplaceRequest,
  buildInsertDimensionRequest,
  buildMergeCellsRequest,
  buildUpdateBordersRequest,
  buildAddNamedRangeRequest,
  gridRangeFromA1,
} from "./builders.js";
import { parseA1Range } from "../../utils/a1.js";

describe("gridRangeFromA1", () => {
  it("maps a parsed A1 range and sheetId into a GridRange", () => {
    expect(gridRangeFromA1(parseA1Range("Sheet1!A1:B2"), 42)).toEqual({
      sheetId: 42,
      startRowIndex: 0,
      endRowIndex: 2,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });
});

describe("buildFindReplaceRequest", () => {
  it("scopes to all sheets by default", () => {
    const req = buildFindReplaceRequest({ find: "a", replacement: "b" });
    expect(req).toEqual({ findReplace: { find: "a", replacement: "b", allSheets: true } });
  });

  it("prefers an explicit range over sheetId, and carries match options", () => {
    const range = { sheetId: 1, startRowIndex: 0, endRowIndex: 5 };
    const req = buildFindReplaceRequest({
      find: "x",
      replacement: "y",
      sheetId: 1,
      range,
      matchCase: true,
      searchByRegex: true,
    });
    expect(req.findReplace).toMatchObject({ find: "x", replacement: "y", range, matchCase: true, searchByRegex: true });
    expect(req.findReplace?.allSheets).toBeUndefined();
    expect(req.findReplace?.sheetId).toBeUndefined();
  });

  it("scopes to a single sheet when a sheetId is given without a range", () => {
    const req = buildFindReplaceRequest({ find: "x", replacement: "y", sheetId: 7 });
    expect(req.findReplace?.sheetId).toBe(7);
    expect(req.findReplace?.allSheets).toBeUndefined();
  });
});

describe("buildInsertDimensionRequest", () => {
  it("builds a ROWS insert with inheritFromBefore defaulting to false", () => {
    expect(buildInsertDimensionRequest({ sheetId: 3, dimension: "ROWS", startIndex: 2, endIndex: 5 })).toEqual({
      insertDimension: {
        range: { sheetId: 3, dimension: "ROWS", startIndex: 2, endIndex: 5 },
        inheritFromBefore: false,
      },
    });
  });
});

describe("buildMergeCellsRequest", () => {
  const range = { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 };
  it("builds a mergeCells request", () => {
    expect(buildMergeCellsRequest({ range, mergeType: "MERGE_ALL" })).toEqual({
      mergeCells: { range, mergeType: "MERGE_ALL" },
    });
  });
});

describe("buildUpdateBordersRequest", () => {
  it("applies one border spec to each requested side", () => {
    const range = { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 };
    const req = buildUpdateBordersRequest({
      range,
      style: "SOLID",
      color: { red: 1 },
      sides: ["top", "bottom"],
    });
    expect(req.updateBorders).toEqual({
      range,
      top: { style: "SOLID", color: { red: 1 } },
      bottom: { style: "SOLID", color: { red: 1 } },
    });
    expect(req.updateBorders?.left).toBeUndefined();
  });
});

describe("buildAddNamedRangeRequest", () => {
  it("wraps a name + range into an addNamedRange request", () => {
    const range = { sheetId: 0, startRowIndex: 0, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 1 };
    expect(buildAddNamedRangeRequest({ name: "Ledger", range })).toEqual({
      addNamedRange: { namedRange: { name: "Ledger", range } },
    });
  });
});
