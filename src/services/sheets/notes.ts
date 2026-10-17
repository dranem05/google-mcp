import { sheets_v4 } from "googleapis";
import { z } from "zod";
import { columnIndexToLetters } from "../../utils/a1.js";
import { DEFAULT_CELL_CAP } from "../../utils/sheets-guard.js";

/**
 * Pure pieces of the sheets_*_note tools: the note-text schema, range
 * validation, the batchUpdate request shapes, and conversion of fetched grid
 * data. Kept free of API calls so they can be unit-tested; the service layer
 * resolves A1 ranges and dispatches.
 *
 * Every request writes only the "note" field, so values and formatting are
 * never touched.
 */

/**
 * Note text for set/append. It must contain a non-space character, so an empty
 * string can never act as a delete; removing notes is sheets_clear_note's job.
 * A regex (rather than a refine) keeps the rule visible in the JSON schema.
 */
export const noteTextSchema = z
  .string()
  .regex(/\S/, "Note text must not be empty or whitespace-only; use sheets_clear_note to remove notes.");

export interface BoundedGridRange {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

/**
 * Narrows a GridRange to one bounded on every side. Whole-row and whole-column
 * ranges are rejected so a note tool never sweeps an entire sheet by accident.
 */
export function assertBoundedRange(r: sheets_v4.Schema$GridRange): BoundedGridRange {
  if (
    r.sheetId == null ||
    r.startRowIndex == null || r.endRowIndex == null ||
    r.startColumnIndex == null || r.endColumnIndex == null
  ) {
    throw new Error("Range must be bounded on every side (e.g. 'B2' or 'B2:C3'); whole-row and whole-column ranges are not allowed.");
  }
  return {
    sheetId: r.sheetId,
    startRowIndex: r.startRowIndex,
    endRowIndex: r.endRowIndex,
    startColumnIndex: r.startColumnIndex,
    endColumnIndex: r.endColumnIndex,
  };
}

/**
 * Caps the client-side work of the note tools: sheets_read_notes returns at most
 * this many notes, and sheets_append_note (which reads and writes every cell
 * individually) accepts ranges of at most this many cells.
 */
export const NOTE_CAP = DEFAULT_CELL_CAP;

/** One note found in fetched data; indexes are absolute, zero-based. */
export interface FoundNote {
  rowIndex: number;
  columnIndex: number;
  note: string;
}

/** Rejects an append range whose cell count exceeds NOTE_CAP, before anything is fetched or built. */
export function assertAppendRangeWithinCap(range: BoundedGridRange, a1: string): void {
  const cells = (range.endRowIndex - range.startRowIndex) * (range.endColumnIndex - range.startColumnIndex);
  if (cells > NOTE_CAP) {
    throw new Error(
      `Range "${a1}" spans ${cells} cells, exceeding the ${NOTE_CAP}-cell cap for sheets_append_note, ` +
      `which rewrites every cell individually. Narrow the range and try again.`
    );
  }
}

/** Rejects a read that found more than NOTE_CAP notes. */
export function assertNoteCountWithinCap(count: number, a1: string): void {
  if (count > NOTE_CAP) {
    throw new Error(`Range "${a1}" has ${count} notes, exceeding the ${NOTE_CAP}-note cap. Narrow the range and try again.`);
  }
}

/** Replaces the note on every cell in the range with the same text. */
export function buildSetNoteRequest(range: BoundedGridRange, note: string): sheets_v4.Schema$Request {
  return { repeatCell: { range, cell: { note }, fields: "note" } };
}

/** Removes the note from every cell in the range (an empty cell under the "note" mask clears it). */
export function buildClearNoteRequest(range: BoundedGridRange): sheets_v4.Schema$Request {
  return { repeatCell: { range, cell: {}, fields: "note" } };
}

/** Joins appended text onto an existing note with one newline; a cell with no note just gets the text. */
export function appendNoteText(existing: string | undefined, text: string): string {
  return existing ? `${existing}\n${text}` : text;
}

/**
 * Appends text to each cell's own existing note. Uses updateCells with one
 * value per cell (not repeatCell) because cells in the range can carry
 * different notes. Allocates one value per cell in the range, so callers
 * bound the range first (assertAppendRangeWithinCap).
 */
export function buildAppendNoteRequest(
  range: BoundedGridRange,
  existing: FoundNote[],
  text: string
): sheets_v4.Schema$Request {
  const byCell = new Map(existing.map((n) => [`${n.rowIndex},${n.columnIndex}`, n.note]));
  const rows: sheets_v4.Schema$RowData[] = [];
  for (let r = range.startRowIndex; r < range.endRowIndex; r++) {
    const values: sheets_v4.Schema$CellData[] = [];
    for (let c = range.startColumnIndex; c < range.endColumnIndex; c++) {
      values.push({ note: appendNoteText(byCell.get(`${r},${c}`), text) });
    }
    rows.push({ values });
  }
  return { updateCells: { range, rows, fields: "note" } };
}

/**
 * Collects the notes inside the range from fetched GridData, walking only what
 * the API returned, so the cost tracks the response rather than the range's
 * size. The API omits trailing empty rows and cells, and an omitted
 * startRow/startColumn means 0.
 */
export function collectNotes(
  data: sheets_v4.Schema$GridData[] | undefined,
  range: BoundedGridRange
): FoundNote[] {
  const found: FoundNote[] = [];
  for (const block of data ?? []) {
    const startRow = block.startRow ?? 0;
    const startColumn = block.startColumn ?? 0;
    (block.rowData ?? []).forEach((row, i) => {
      (row.values ?? []).forEach((cell, j) => {
        const rowIndex = startRow + i;
        const columnIndex = startColumn + j;
        if (
          cell.note != null &&
          rowIndex >= range.startRowIndex && rowIndex < range.endRowIndex &&
          columnIndex >= range.startColumnIndex && columnIndex < range.endColumnIndex
        ) {
          found.push({ rowIndex, columnIndex, note: cell.note });
        }
      });
    });
  }
  return found;
}

/** Sheet-qualified A1 for one cell. The sheet name is always quoted, which is valid for any name. */
export function formatCellA1(sheetTitle: string, rowIndex: number, columnIndex: number): string {
  return `'${sheetTitle.replace(/'/g, "''")}'!${columnIndexToLetters(columnIndex)}${rowIndex + 1}`;
}

/** Formats found notes as sheet-qualified {cell, note} pairs, row by row. */
export function listNotes(found: FoundNote[], sheetTitle: string): { cell: string; note: string }[] {
  return [...found]
    .sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex)
    .map((n) => ({ cell: formatCellA1(sheetTitle, n.rowIndex, n.columnIndex), note: n.note }));
}
