import { describe, expect, it } from "vitest";
import {
  noteTextSchema,
  assertBoundedRange,
  buildSetNoteRequest,
  buildClearNoteRequest,
  buildAppendNoteRequest,
  appendNoteText,
  assertAppendRangeWithinCap,
  assertNoteCountWithinCap,
  collectNotes,
  formatCellA1,
  listNotes,
  NOTE_CAP,
} from "./notes.js";
import { gridRangeFromA1 } from "./builders.js";
import { parseA1Range } from "../../utils/a1.js";

// B2:C3 on sheet 7.
const range = { sheetId: 7, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 3 };

describe("noteTextSchema", () => {
  it("accepts text with a non-space character", () => {
    expect(noteTextSchema.safeParse("check this").success).toBe(true);
    expect(noteTextSchema.safeParse("  x  ").success).toBe(true);
  });

  it.each(["", " ", "  \n\t "])("rejects %j instead of treating it as a delete", (text) => {
    const result = noteTextSchema.safeParse(text);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/must not be empty/);
  });
});

describe("assertBoundedRange", () => {
  it("passes a single cell and a block through", () => {
    expect(assertBoundedRange(gridRangeFromA1(parseA1Range("B2"), 7))).toEqual({
      sheetId: 7, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2,
    });
    expect(assertBoundedRange(gridRangeFromA1(parseA1Range("B2:C3"), 7))).toEqual(range);
  });

  it.each(["A:B", "A1:B", "A:B2"])("rejects the unbounded range %s", (a1) => {
    expect(() => assertBoundedRange(gridRangeFromA1(parseA1Range(a1), 7))).toThrow(/bounded/);
  });
});

describe("buildSetNoteRequest", () => {
  it("repeats the note across the range and writes only the note field", () => {
    expect(buildSetNoteRequest(range, "check this")).toEqual({
      repeatCell: { range, cell: { note: "check this" }, fields: "note" },
    });
  });
});

describe("buildClearNoteRequest", () => {
  it("writes an empty cell under the note mask", () => {
    expect(buildClearNoteRequest(range)).toEqual({
      repeatCell: { range, cell: {}, fields: "note" },
    });
  });
});

describe("appendNoteText", () => {
  it("joins onto an existing note with one newline", () => {
    expect(appendNoteText("old", "new")).toBe("old\nnew");
  });

  it("uses the text alone when there is no note", () => {
    expect(appendNoteText(undefined, "new")).toBe("new");
  });
});

describe("buildAppendNoteRequest", () => {
  it("gives every cell its own result, row by row", () => {
    const existing = [{ rowIndex: 1, columnIndex: 1, note: "a" }, { rowIndex: 2, columnIndex: 2, note: "d" }];
    expect(buildAppendNoteRequest(range, existing, "new")).toEqual({
      updateCells: {
        range,
        rows: [
          { values: [{ note: "a\nnew" }, { note: "new" }] },
          { values: [{ note: "new" }, { note: "d\nnew" }] },
        ],
        fields: "note",
      },
    });
  });

  it("covers the whole range when no cell has a note", () => {
    expect(buildAppendNoteRequest(range, [], "new").updateCells?.rows).toEqual([
      { values: [{ note: "new" }, { note: "new" }] },
      { values: [{ note: "new" }, { note: "new" }] },
    ]);
  });
});

describe("assertAppendRangeWithinCap", () => {
  const rows = (n: number) => ({ sheetId: 0, startRowIndex: 0, endRowIndex: n, startColumnIndex: 0, endColumnIndex: 10 });

  it("accepts a range of exactly the cap", () => {
    expect(() => assertAppendRangeWithinCap(rows(NOTE_CAP / 10), "A1:J1000")).not.toThrow();
  });

  it("rejects a range one row over the cap, naming the cap", () => {
    expect(() => assertAppendRangeWithinCap(rows(NOTE_CAP / 10 + 1), "A1:J1001"))
      .toThrow(/"A1:J1001" spans 10010 cells, exceeding the 10000-cell cap/);
  });
});

describe("assertNoteCountWithinCap", () => {
  it("allows the cap and rejects one more, counting notes", () => {
    expect(() => assertNoteCountWithinCap(NOTE_CAP, "A1:Z9")).not.toThrow();
    expect(() => assertNoteCountWithinCap(NOTE_CAP + 1, "A1:Z9")).toThrow(/10001 notes, exceeding the 10000-note cap/);
  });
});

describe("collectNotes", () => {
  it("reads sparse data, treating empty rows and omitted cells as no note", () => {
    const data = [{
      startRow: 1,
      startColumn: 1,
      rowData: [{ values: [{}, { note: "c2" }] }, {}],
    }];
    expect(collectNotes(data, range)).toEqual([{ rowIndex: 1, columnIndex: 2, note: "c2" }]);
  });

  it("treats omitted startRow/startColumn as 0 and ignores cells outside the range", () => {
    const data = [{
      rowData: [{ values: [{ note: "a1" }] }, { values: [{}, { note: "b2" }, { note: "c2" }, { note: "d2" }] }],
    }];
    expect(collectNotes(data, range)).toEqual([
      { rowIndex: 1, columnIndex: 1, note: "b2" },
      { rowIndex: 1, columnIndex: 2, note: "c2" },
    ]);
  });

  it("returns nothing when there is no data", () => {
    expect(collectNotes(undefined, range)).toEqual([]);
  });

  it("costs what the response holds, not what the range spans", () => {
    // 1,000,000 rows x 700 columns: a dense grid of this would need hundreds of millions of slots.
    const huge = { sheetId: 0, startRowIndex: 0, endRowIndex: 1_000_000, startColumnIndex: 0, endColumnIndex: 700 };
    const data = [{ rowData: [{ values: [{ note: "a" }] }] }, { startRow: 999_999, startColumn: 699, rowData: [{ values: [{ note: "z" }] }] }];
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const found = collectNotes(data, huge);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(10_000_000);
    expect(listNotes(found, "S")).toEqual([{ cell: "'S'!A1", note: "a" }, { cell: "'S'!ZX1000000", note: "z" }]);
  });
});

describe("formatCellA1", () => {
  it("quotes the sheet name and escapes embedded quotes", () => {
    expect(formatCellA1("My Sheet", 1, 1)).toBe("'My Sheet'!B2");
    expect(formatCellA1("Bob's", 0, 26)).toBe("'Bob''s'!AA1");
  });

  it("round-trips through parseA1Range", () => {
    const parsed = parseA1Range(formatCellA1("Bob's Q3", 9, 27));
    expect(parsed).toMatchObject({ sheetName: "Bob's Q3", startRowIndex: 9, startColumnIndex: 27 });
  });
});

describe("listNotes", () => {
  it("formats sheet-qualified cells in row-major order", () => {
    const found = [{ rowIndex: 2, columnIndex: 2, note: "d" }, { rowIndex: 1, columnIndex: 1, note: "a" }];
    expect(listNotes(found, "My Sheet")).toEqual([
      { cell: "'My Sheet'!B2", note: "a" },
      { cell: "'My Sheet'!C3", note: "d" },
    ]);
  });

  it("returns an empty list when nothing was found", () => {
    expect(listNotes([], "S")).toEqual([]);
  });
});
