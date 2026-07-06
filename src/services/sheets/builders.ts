import { sheets_v4 } from "googleapis";
import { ParsedA1Range } from "../../utils/a1.js";

/**
 * Pure builders for the Sheets `batchUpdate` request shapes introduced in
 * Task 5 (find/replace, insert dimensions, merge cells, borders, named ranges).
 * Kept free of any API calls so the exact request JSON can be unit-tested; the
 * service layer resolves sheet names to sheetIds and dispatches these.
 */

export interface RgbColor {
  red?: number;
  green?: number;
  blue?: number;
}

/** Builds a GridRange from a parsed A1 range plus the resolved numeric sheetId. */
export function gridRangeFromA1(parsed: ParsedA1Range, sheetId: number): sheets_v4.Schema$GridRange {
  return {
    sheetId,
    startRowIndex: parsed.startRowIndex,
    endRowIndex: parsed.endRowIndex,
    startColumnIndex: parsed.startColumnIndex,
    endColumnIndex: parsed.endColumnIndex,
  };
}

export interface FindReplaceOptions {
  find: string;
  replacement: string;
  matchCase?: boolean;
  matchEntireCell?: boolean;
  searchByRegex?: boolean;
  /** Scope: all sheets. Mutually exclusive with sheetId/range. */
  allSheets?: boolean;
  /** Scope: one sheet by id. */
  sheetId?: number;
  /** Scope: a specific grid range. */
  range?: sheets_v4.Schema$GridRange;
}

export function buildFindReplaceRequest(opts: FindReplaceOptions): sheets_v4.Schema$Request {
  const findReplace: sheets_v4.Schema$FindReplaceRequest = {
    find: opts.find,
    replacement: opts.replacement,
  };
  if (opts.matchCase !== undefined) findReplace.matchCase = opts.matchCase;
  if (opts.matchEntireCell !== undefined) findReplace.matchEntireCell = opts.matchEntireCell;
  if (opts.searchByRegex !== undefined) findReplace.searchByRegex = opts.searchByRegex;
  // Scope precedence: an explicit range wins, then a single sheet, else all sheets.
  if (opts.range) findReplace.range = opts.range;
  else if (opts.sheetId !== undefined) findReplace.sheetId = opts.sheetId;
  else findReplace.allSheets = opts.allSheets ?? true;
  return { findReplace };
}

export function buildInsertDimensionRequest(opts: {
  sheetId: number;
  dimension: "ROWS" | "COLUMNS";
  startIndex: number;
  endIndex: number;
  inheritFromBefore?: boolean;
}): sheets_v4.Schema$Request {
  return {
    insertDimension: {
      range: {
        sheetId: opts.sheetId,
        dimension: opts.dimension,
        startIndex: opts.startIndex,
        endIndex: opts.endIndex,
      },
      inheritFromBefore: opts.inheritFromBefore ?? false,
    },
  };
}

export function buildMergeCellsRequest(opts: {
  range: sheets_v4.Schema$GridRange;
  mergeType: "MERGE_ALL" | "MERGE_COLUMNS" | "MERGE_ROWS";
}): sheets_v4.Schema$Request {
  return { mergeCells: { range: opts.range, mergeType: opts.mergeType } };
}

export type BorderSide = "top" | "bottom" | "left" | "right" | "innerHorizontal" | "innerVertical";

export function buildUpdateBordersRequest(opts: {
  range: sheets_v4.Schema$GridRange;
  style: "SOLID" | "SOLID_MEDIUM" | "SOLID_THICK" | "DASHED" | "DOTTED" | "DOUBLE" | "NONE";
  color?: RgbColor;
  sides: BorderSide[];
}): sheets_v4.Schema$Request {
  const border: sheets_v4.Schema$Border = { style: opts.style };
  if (opts.color) border.color = opts.color;
  const req: sheets_v4.Schema$UpdateBordersRequest = { range: opts.range };
  for (const side of opts.sides) req[side] = border;
  return { updateBorders: req };
}

export function buildAddNamedRangeRequest(opts: {
  name: string;
  range: sheets_v4.Schema$GridRange;
}): sheets_v4.Schema$Request {
  return { addNamedRange: { namedRange: { name: opts.name, range: opts.range } } };
}
