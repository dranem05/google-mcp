/**
 * Parses A1-notation ranges (the strings users type, e.g. "Sheet1!A1:B100",
 * "A1:B100", "A:B") into the row/column indexes used by the Sheets API's
 * GridRange (https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/other#GridRange).
 *
 * GridRange semantics: zero-based, half-open ([start, end)) indexes. A
 * missing start/end index means "unbounded on that side" (e.g. a whole
 * column has no row bounds).
 */
export interface ParsedA1Range {
  /** Sheet name from a "Sheet1!..." prefix, or null if the range has none. */
  sheetName: string | null;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

interface CellRef {
  /** Zero-based column index. */
  col: number;
  /** Zero-based row index, or undefined for a column-only reference (e.g. "B" in "A:B"). */
  row?: number;
}

const CELL_REF_PATTERN = /^([A-Za-z]+)(\d+)?$/;

function columnLettersToIndex(letters: string): number {
  let result = 0;
  for (const ch of letters.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64); // 'A' -> 1
  }
  return result - 1; // convert to zero-based
}

function unquoteSheetName(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function splitSheetAndRange(input: string): { sheetName: string | null; rangePart: string } {
  const bangIndex = input.lastIndexOf("!");
  if (bangIndex === -1) return { sheetName: null, rangePart: input };
  return {
    sheetName: unquoteSheetName(input.slice(0, bangIndex)),
    rangePart: input.slice(bangIndex + 1),
  };
}

function parseCellRef(ref: string, original: string): CellRef {
  const match = CELL_REF_PATTERN.exec(ref);
  if (!match || !match[1]) {
    throw new Error(`Invalid A1 range: "${original}" (bad cell reference "${ref}")`);
  }
  const [, letters, digits] = match;
  return {
    col: columnLettersToIndex(letters),
    row: digits !== undefined ? Number(digits) - 1 : undefined,
  };
}

/**
 * Parses an A1-notation range into sheet name + GridRange-shaped indexes.
 * Supports sheet-qualified ranges ("Sheet1!A1:B100", with optional
 * single-quoting for names with spaces), bare ranges ("A1:B100"), single
 * cells ("A1"), and whole-column ranges ("A:B", unbounded rows).
 *
 * Throws on malformed input rather than silently returning a nonsensical
 * range.
 */
export function parseA1Range(input: string): ParsedA1Range {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(`Invalid A1 range: "${input}"`);

  const { sheetName, rangePart } = splitSheetAndRange(trimmed);
  if (!rangePart) throw new Error(`Invalid A1 range: "${input}" (empty range part)`);

  const refs = rangePart.split(":");
  if (refs.length > 2) {
    throw new Error(`Invalid A1 range: "${input}" (too many ":"-separated parts)`);
  }

  const start = parseCellRef(refs[0], input);
  const end = refs.length === 2 ? parseCellRef(refs[1], input) : start;

  const startColumnIndex = Math.min(start.col, end.col);
  const endColumnIndex = Math.max(start.col, end.col) + 1;

  let startRowIndex: number | undefined;
  let endRowIndex: number | undefined;
  if (start.row !== undefined && end.row !== undefined) {
    startRowIndex = Math.min(start.row, end.row);
    endRowIndex = Math.max(start.row, end.row) + 1;
  } else if (start.row !== undefined) {
    startRowIndex = start.row;
  } else if (end.row !== undefined) {
    endRowIndex = end.row + 1;
  }

  return { sheetName, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex };
}
