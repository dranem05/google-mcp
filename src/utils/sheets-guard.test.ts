import { describe, expect, it } from "vitest";
import { assertCellCountWithinCap, CellCountExceededError, countCells, DEFAULT_CELL_CAP } from "./sheets-guard.js";

describe("countCells", () => {
  it("sums row lengths", () => {
    expect(countCells([[1, 2, 3], [4, 5]])).toBe(5);
  });

  it("treats missing/empty grids as zero", () => {
    expect(countCells(null)).toBe(0);
    expect(countCells(undefined)).toBe(0);
    expect(countCells([])).toBe(0);
  });

  it("tolerates sparse/missing rows", () => {
    expect(countCells([[1], undefined as unknown as unknown[], [2, 3]])).toBe(3);
  });
});

describe("assertCellCountWithinCap", () => {
  it("does not throw when under the cap", () => {
    expect(() => assertCellCountWithinCap(100, "A1:B2")).not.toThrow();
  });

  it("does not throw when exactly at the cap", () => {
    expect(() => assertCellCountWithinCap(DEFAULT_CELL_CAP, "A1:Z1000")).not.toThrow();
  });

  it("throws CellCountExceededError when over the default cap", () => {
    expect(() => assertCellCountWithinCap(DEFAULT_CELL_CAP + 1, "A1:Z100000")).toThrow(CellCountExceededError);
  });

  it("includes the range and a narrowing hint in the error message", () => {
    try {
      assertCellCountWithinCap(20000, "Sheet1!A1:Z100000");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CellCountExceededError);
      expect((e as Error).message).toContain("Sheet1!A1:Z100000");
      expect((e as Error).message).toContain("20000");
      expect((e as Error).message).toContain("Narrow the range");
    }
  });

  it("honors a custom cap", () => {
    expect(() => assertCellCountWithinCap(50, "A1:B10", 10)).toThrow(CellCountExceededError);
    expect(() => assertCellCountWithinCap(5, "A1:B10", 10)).not.toThrow();
  });
});
