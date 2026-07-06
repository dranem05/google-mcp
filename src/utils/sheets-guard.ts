/**
 * Sheets responses (values or per-cell formatting) scale with the number of
 * cells actually returned, which can quickly blow past the model's context
 * budget for a range that looks innocuous in A1 notation (e.g. a whole
 * column). Rather than truncate silently, we fail loudly and tell the model
 * how to fix it: narrow the range and retry.
 */
export const DEFAULT_CELL_CAP = 10_000;

export class CellCountExceededError extends Error {
  constructor(range: string, cellCount: number, cap: number) {
    super(
      `Range "${range}" returned ${cellCount} cells, exceeding the ${cap}-cell cap. ` +
      `Narrow the range (fewer rows/columns) and try again.`
    );
    this.name = "CellCountExceededError";
  }
}

/** Throws CellCountExceededError when `cellCount` exceeds `cap` (default DEFAULT_CELL_CAP). */
export function assertCellCountWithinCap(cellCount: number, range: string, cap: number = DEFAULT_CELL_CAP): void {
  if (cellCount > cap) {
    throw new CellCountExceededError(range, cellCount, cap);
  }
}

/** Sums row lengths in a 2D array (e.g. Sheets values grid), treating a missing grid as zero cells. */
export function countCells(rows: readonly (readonly unknown[])[] | null | undefined): number {
  if (!rows) return 0;
  let count = 0;
  for (const row of rows) count += row?.length ?? 0;
  return count;
}
