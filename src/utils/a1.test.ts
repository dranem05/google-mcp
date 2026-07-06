import { describe, expect, it } from "vitest";
import { parseA1Range } from "./a1.js";

describe("parseA1Range", () => {
  it("parses a sheet-qualified bounded range", () => {
    expect(parseA1Range("Sheet1!A1:B100")).toEqual({
      sheetName: "Sheet1",
      startRowIndex: 0,
      endRowIndex: 100,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });

  it("parses a bare bounded range with no sheet name", () => {
    expect(parseA1Range("A1:B100")).toEqual({
      sheetName: null,
      startRowIndex: 0,
      endRowIndex: 100,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });

  it("parses a whole-column range with unbounded rows", () => {
    expect(parseA1Range("A:B")).toEqual({
      sheetName: null,
      startRowIndex: undefined,
      endRowIndex: undefined,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });

  it("parses a single-cell reference as a 1x1 range", () => {
    expect(parseA1Range("A1")).toEqual({
      sheetName: null,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 1,
    });
  });

  it("handles a quoted sheet name with spaces", () => {
    expect(parseA1Range("'My Sheet'!A1:C3")).toEqual({
      sheetName: "My Sheet",
      startRowIndex: 0,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
  });

  it("unescapes doubled single quotes in a quoted sheet name", () => {
    expect(parseA1Range("'Bob''s Sheet'!A1")).toEqual({
      sheetName: "Bob's Sheet",
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 1,
    });
  });

  it("normalizes a reversed range (end before start)", () => {
    expect(parseA1Range("B2:A1")).toEqual({
      sheetName: null,
      startRowIndex: 0,
      endRowIndex: 2,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
  });

  it("handles multi-letter columns", () => {
    expect(parseA1Range("AA1:AB2")).toEqual({
      sheetName: null,
      startRowIndex: 0,
      endRowIndex: 2,
      startColumnIndex: 26,
      endColumnIndex: 28,
    });
  });

  it("throws on an empty string", () => {
    expect(() => parseA1Range("")).toThrow();
  });

  it("throws on a range with too many colon-separated parts", () => {
    expect(() => parseA1Range("A1:B1:C1")).toThrow();
  });

  it("throws on a reference with no column letters", () => {
    expect(() => parseA1Range("Sheet1!1:5")).toThrow();
  });
});
