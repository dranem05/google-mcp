import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, sheets_v4 } from "googleapis";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";
import { parseA1Range } from "../../utils/a1.js";
import { assertCellCountWithinCap, countCells } from "../../utils/sheets-guard.js";
import {
  buildFindReplaceRequest,
  buildInsertDimensionRequest,
  buildMergeCellsRequest,
  buildUpdateBordersRequest,
  buildAddNamedRangeRequest,
  gridRangeFromA1,
  type BorderSide,
} from "./builders.js";

export function registerSheetsTools(server: McpServer, ctx: ServiceContext): void {
  const api = google.sheets({ version: "v4", auth: ctx.auth });
  const driveApi = google.drive({ version: "v3", auth: ctx.auth });

  /** Resolves a sheet name to its numeric sheetId within a spreadsheet. */
  async function resolveSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
    const info = await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" });
    const match = info.data.sheets?.find((s) => s.properties?.title === sheetName);
    if (!match || match.properties?.sheetId == null) {
      throw new Error(`Sheet "${sheetName}" not found in spreadsheet ${spreadsheetId}`);
    }
    return match.properties.sheetId;
  }

  /**
   * Turns an A1 range into a GridRange. The target sheet comes from the range's
   * own "Sheet1!" prefix if present, otherwise from fallbackSheetId. Throws if
   * neither identifies a sheet.
   */
  async function resolveGridRange(
    spreadsheetId: string,
    a1: string,
    fallbackSheetId?: number
  ): Promise<sheets_v4.Schema$GridRange> {
    const parsed = parseA1Range(a1);
    let sheetId = fallbackSheetId;
    if (parsed.sheetName) sheetId = await resolveSheetId(spreadsheetId, parsed.sheetName);
    if (sheetId === undefined) {
      throw new Error(`Provide a sheet-qualified range (e.g. 'Sheet1!A1:C3') or a sheetId for "${a1}".`);
    }
    return gridRangeFromA1(parsed, sheetId);
  }

  server.tool("sheets_read", "Read data from a spreadsheet range", {
    spreadsheetId: z.string(),
    range: z.string().describe("A1 notation (e.g., 'Sheet1!A1:C10')"),
    valueRenderOption: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional().default("FORMATTED_VALUE"),
  }, async ({ spreadsheetId, range, valueRenderOption }) => {
    const res = await api.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption });
    assertCellCountWithinCap(countCells(res.data.values), range);
    return textResult({ range: res.data.range, values: res.data.values });
  });

  server.tool("sheets_write", "Write data to a spreadsheet range", {
    spreadsheetId: z.string(),
    range: z.string(),
    values: z.array(z.array(z.unknown())).describe("2D array of values"),
    valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
  }, async ({ spreadsheetId, range, values, valueInputOption }) => {
    const res = await api.spreadsheets.values.update({
      spreadsheetId, range, valueInputOption,
      requestBody: { values },
    });
    return textResult({ updatedRange: res.data.updatedRange, updatedCells: res.data.updatedCells });
  });

  server.tool("sheets_batch_write", "Write data to multiple ranges at once", {
    spreadsheetId: z.string(),
    data: z.array(z.object({ range: z.string(), values: z.array(z.array(z.unknown())) })),
    valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
  }, async ({ spreadsheetId, data, valueInputOption }) => {
    const res = await api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption, data },
    });
    return textResult({ totalUpdatedCells: res.data.totalUpdatedCells, totalUpdatedSheets: res.data.totalUpdatedSheets });
  });

  server.tool("sheets_create", "Create a new spreadsheet", {
    title: z.string(),
    sheetTitles: z.array(z.string()).optional().describe("Names of initial sheets"),
  }, async ({ title, sheetTitles }) => {
    const sheets = sheetTitles?.map((t) => ({ properties: { title: t } }));
    const res = await api.spreadsheets.create({
      requestBody: { properties: { title }, sheets },
    });
    return textResult({
      spreadsheetId: res.data.spreadsheetId,
      url: res.data.spreadsheetUrl,
      sheets: res.data.sheets?.map((s) => ({ sheetId: s.properties?.sheetId, title: s.properties?.title })),
    });
  });

  server.tool("sheets_get_info", "Get spreadsheet metadata", {
    spreadsheetId: z.string(),
  }, async ({ spreadsheetId }) => {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      fields: "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,gridProperties.rowCount,gridProperties.columnCount)",
    });
    return textResult({
      spreadsheetId: res.data.spreadsheetId,
      title: res.data.properties?.title,
      url: res.data.spreadsheetUrl,
      sheets: res.data.sheets?.map((s) => ({
        sheetId: s.properties?.sheetId,
        title: s.properties?.title,
        rowCount: s.properties?.gridProperties?.rowCount,
        columnCount: s.properties?.gridProperties?.columnCount,
      })),
    });
  });

  server.tool("sheets_list", "List spreadsheets in Drive", {
    maxResults: z.number().optional().default(20),
    pageToken: z.string().optional().describe("Token from a previous call's nextPageToken to fetch the next page"),
  }, async ({ maxResults, pageToken }) => {
    const res = await driveApi.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      pageSize: maxResults,
      pageToken,
      orderBy: "modifiedTime desc",
      fields: "nextPageToken,files(id,name,modifiedTime,webViewLink)",
    });
    return textResult({
      files: res.data.files || [],
      total: res.data.files?.length || 0,
      hasMore: !!res.data.nextPageToken,
      nextPageToken: res.data.nextPageToken,
    });
  });

  server.tool("sheets_add_sheet", "Add a new sheet (tab) to a spreadsheet", {
    spreadsheetId: z.string(),
    title: z.string(),
    rowCount: z.number().optional(),
    columnCount: z.number().optional(),
  }, async ({ spreadsheetId, title, rowCount, columnCount }) => {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: rowCount || 1000, columnCount: columnCount || 26 } } } }],
      },
    });
    const sheet = res.data.replies?.[0]?.addSheet;
    return textResult({ sheetId: sheet?.properties?.sheetId, title: sheet?.properties?.title });
  });

  server.tool("sheets_delete_sheet", "Delete a sheet from a spreadsheet", {
    spreadsheetId: z.string(),
    sheetId: z.number().describe("Sheet ID (not the sheet name)"),
  }, async ({ spreadsheetId, sheetId }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId } }] },
    });
    return textResult({ success: true, sheetId });
  });

  server.tool("sheets_rename_sheet", "Rename a sheet", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    newTitle: z.string(),
  }, async ({ spreadsheetId, sheetId, newTitle }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ updateSheetProperties: { properties: { sheetId, title: newTitle }, fields: "title" } }],
      },
    });
    return textResult({ success: true, sheetId, newTitle });
  });

  server.tool("sheets_duplicate_sheet", "Duplicate a sheet", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    newTitle: z.string().optional(),
    insertIndex: z.number().optional(),
  }, async ({ spreadsheetId, sheetId, newTitle, insertIndex }) => {
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ duplicateSheet: { sourceSheetId: sheetId, newSheetName: newTitle, insertSheetIndex: insertIndex } }],
      },
    });
    const dup = res.data.replies?.[0]?.duplicateSheet;
    return textResult({ sheetId: dup?.properties?.sheetId, title: dup?.properties?.title });
  });

  server.tool("sheets_append_rows", "Append rows to the end of a sheet", {
    spreadsheetId: z.string(),
    range: z.string().describe("A1 range to search for a table (e.g., 'Sheet1')"),
    values: z.array(z.array(z.unknown())),
    valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional().default("USER_ENTERED"),
  }, async ({ spreadsheetId, range, values, valueInputOption }) => {
    const res = await api.spreadsheets.values.append({
      spreadsheetId, range, valueInputOption,
      requestBody: { values },
    });
    return textResult({ updatedRange: res.data.updates?.updatedRange, updatedRows: res.data.updates?.updatedRows });
  });

  server.tool("sheets_clear_range", "Clear all values from a range", {
    spreadsheetId: z.string(),
    range: z.string(),
  }, async ({ spreadsheetId, range }) => {
    const res = await api.spreadsheets.values.clear({ spreadsheetId, range });
    return textResult({ clearedRange: res.data.clearedRange });
  });

  server.tool("sheets_delete_range", "Delete rows or columns from a sheet", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    dimension: z.enum(["ROWS", "COLUMNS"]),
    startIndex: z.number(),
    endIndex: z.number(),
  }, async ({ spreadsheetId, sheetId, dimension, startIndex, endIndex }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ deleteDimension: { range: { sheetId, dimension, startIndex, endIndex } } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_read_cell_format", "Read formatting of cells in a range", {
    spreadsheetId: z.string(),
    range: z.string(),
  }, async ({ spreadsheetId, range }) => {
    const res = await api.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      includeGridData: true,
      fields: "sheets.data.rowData.values(formattedValue,effectiveFormat)",
    });
    const grid = res.data.sheets?.[0]?.data?.[0];
    const cellCount = (grid?.rowData || []).reduce((sum, row) => sum + (row.values?.length || 0), 0);
    assertCellCountWithinCap(cellCount, range);
    const formats = grid?.rowData?.map((row) =>
      row.values?.map((cell) => ({
        value: cell.formattedValue,
        format: cell.effectiveFormat,
      }))
    );
    return textResult(formats);
  });

  server.tool("sheets_format_cells", "Apply formatting to a cell range", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startRowIndex: z.number(),
    endRowIndex: z.number(),
    startColumnIndex: z.number(),
    endColumnIndex: z.number(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontSize: z.number().optional(),
    backgroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional(),
    horizontalAlignment: z.enum(["LEFT", "CENTER", "RIGHT"]).optional(),
    numberFormat: z.object({ type: z.string(), pattern: z.string() }).optional(),
  }, async (opts) => {
    const format: Record<string, unknown> = {};
    const fields: string[] = [];
    if (opts.bold !== undefined || opts.italic !== undefined || opts.fontSize !== undefined) {
      const tf: Record<string, unknown> = {};
      if (opts.bold !== undefined) tf.bold = opts.bold;
      if (opts.italic !== undefined) tf.italic = opts.italic;
      if (opts.fontSize !== undefined) tf.fontSize = opts.fontSize;
      format.textFormat = tf;
      fields.push("userEnteredFormat.textFormat");
    }
    if (opts.backgroundColor) {
      format.backgroundColor = opts.backgroundColor;
      fields.push("userEnteredFormat.backgroundColor");
    }
    if (opts.horizontalAlignment) {
      format.horizontalAlignment = opts.horizontalAlignment;
      fields.push("userEnteredFormat.horizontalAlignment");
    }
    if (opts.numberFormat) {
      format.numberFormat = opts.numberFormat;
      fields.push("userEnteredFormat.numberFormat");
    }

    await api.spreadsheets.batchUpdate({
      spreadsheetId: opts.spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: opts.sheetId, startRowIndex: opts.startRowIndex, endRowIndex: opts.endRowIndex, startColumnIndex: opts.startColumnIndex, endColumnIndex: opts.endColumnIndex },
            cell: { userEnteredFormat: format },
            fields: fields.join(","),
          },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_add_conditional_formatting", "Add conditional formatting to a range", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startRowIndex: z.number(),
    endRowIndex: z.number(),
    startColumnIndex: z.number(),
    endColumnIndex: z.number(),
    type: z.enum(["NUMBER_GREATER", "NUMBER_LESS", "TEXT_CONTAINS", "CUSTOM_FORMULA"]),
    value: z.string().describe("Comparison value or formula"),
    backgroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }),
  }, async (opts) => {
    const conditionType = opts.type === "CUSTOM_FORMULA" ? "CUSTOM_FORMULA"
      : opts.type === "NUMBER_GREATER" ? "NUMBER_GREATER"
      : opts.type === "NUMBER_LESS" ? "NUMBER_LESS" : "TEXT_CONTAINS";

    await api.spreadsheets.batchUpdate({
      spreadsheetId: opts.spreadsheetId,
      requestBody: {
        requests: [{
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId: opts.sheetId, startRowIndex: opts.startRowIndex, endRowIndex: opts.endRowIndex, startColumnIndex: opts.startColumnIndex, endColumnIndex: opts.endColumnIndex }],
              booleanRule: {
                condition: { type: conditionType, values: [{ userEnteredValue: opts.value }] },
                format: { backgroundColor: opts.backgroundColor },
              },
            },
            index: 0,
          },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_set_column_widths", "Set column widths", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startIndex: z.number(),
    endIndex: z.number(),
    pixelSize: z.number(),
  }, async ({ spreadsheetId, sheetId, startIndex, endIndex, pixelSize }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex, endIndex },
            properties: { pixelSize },
            fields: "pixelSize",
          },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_auto_resize_columns", "Auto-resize columns to fit content", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startIndex: z.number().optional().default(0),
    endIndex: z.number().optional(),
  }, async ({ spreadsheetId, sheetId, startIndex, endIndex }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: "COLUMNS", startIndex, endIndex: endIndex || undefined },
          },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_freeze_rows_and_columns", "Freeze rows and/or columns", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    frozenRowCount: z.number().optional(),
    frozenColumnCount: z.number().optional(),
  }, async ({ spreadsheetId, sheetId, frozenRowCount, frozenColumnCount }) => {
    const gridProperties: Record<string, number> = {};
    const fields: string[] = [];
    if (frozenRowCount !== undefined) { gridProperties.frozenRowCount = frozenRowCount; fields.push("gridProperties.frozenRowCount"); }
    if (frozenColumnCount !== undefined) { gridProperties.frozenColumnCount = frozenColumnCount; fields.push("gridProperties.frozenColumnCount"); }

    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties }, fields: fields.join(",") } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_set_dropdown_validation", "Set dropdown validation on cells", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startRowIndex: z.number(),
    endRowIndex: z.number(),
    startColumnIndex: z.number(),
    endColumnIndex: z.number(),
    values: z.array(z.string()).describe("Allowed dropdown values"),
    strict: z.boolean().optional().default(true).describe("Reject input not in the list"),
  }, async (opts) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: opts.spreadsheetId,
      requestBody: {
        requests: [{
          setDataValidation: {
            range: { sheetId: opts.sheetId, startRowIndex: opts.startRowIndex, endRowIndex: opts.endRowIndex, startColumnIndex: opts.startColumnIndex, endColumnIndex: opts.endColumnIndex },
            rule: {
              condition: { type: "ONE_OF_LIST", values: opts.values.map((v) => ({ userEnteredValue: v })) },
              strict: opts.strict,
              showCustomUi: true,
            },
          },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_group_rows", "Group rows (collapse/expand)", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startIndex: z.number(),
    endIndex: z.number(),
  }, async ({ spreadsheetId, sheetId, startIndex, endIndex }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addDimensionGroup: { range: { sheetId, dimension: "ROWS", startIndex, endIndex } },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_ungroup_all_rows", "Remove all row groupings from a sheet", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
  }, async ({ spreadsheetId, sheetId }) => {
    const info = await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,gridProperties.rowCount)" });
    const sheet = info.data.sheets?.find((s) => s.properties?.sheetId === sheetId);
    const rowCount = sheet?.properties?.gridProperties?.rowCount || 1000;

    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimensionGroup: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: rowCount } },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_insert_chart", "Insert a chart into a sheet", {
    spreadsheetId: z.string(),
    sheetId: z.number().describe("Sheet ID where the chart will be anchored"),
    chartType: z.enum(["BAR", "LINE", "PIE", "COLUMN", "AREA", "SCATTER"]),
    title: z.string().optional(),
    dataRange: z.string().describe(
      "A1 notation of the data range for the chart, e.g. 'Sheet1!A1:B100', bare 'A1:B100', or whole-column 'A:B'. " +
      "The first column is the domain (labels); any remaining columns become separate series. " +
      "If the range has no sheet-name prefix, it's assumed to be on the anchor sheet (sheetId)."
    ),
    anchorRowIndex: z.number().optional().default(0),
    anchorColumnIndex: z.number().optional().default(0),
  }, async ({ spreadsheetId, sheetId, chartType, title, dataRange, anchorRowIndex, anchorColumnIndex }) => {
    const parsed = parseA1Range(dataRange);

    let dataSheetId = sheetId;
    if (parsed.sheetName) {
      const info = await api.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties(sheetId,title)",
      });
      const match = info.data.sheets?.find((s) => s.properties?.title === parsed.sheetName);
      if (!match || match.properties?.sheetId == null) {
        throw new Error(`Sheet "${parsed.sheetName}" not found in spreadsheet ${spreadsheetId}`);
      }
      dataSheetId = match.properties.sheetId;
    }

    if (parsed.startColumnIndex === undefined || parsed.endColumnIndex === undefined) {
      throw new Error(`dataRange "${dataRange}" must specify a column range`);
    }
    if (parsed.endColumnIndex - parsed.startColumnIndex < 2) {
      throw new Error(`dataRange "${dataRange}" must include at least 2 columns: one domain column and at least one series column`);
    }

    const baseSource: sheets_v4.Schema$GridRange = {
      sheetId: dataSheetId,
      startRowIndex: parsed.startRowIndex,
      endRowIndex: parsed.endRowIndex,
    };
    const domainSources: sheets_v4.Schema$GridRange[] = [{
      ...baseSource,
      startColumnIndex: parsed.startColumnIndex,
      endColumnIndex: parsed.startColumnIndex + 1,
    }];
    const series: sheets_v4.Schema$BasicChartSeries[] = [];
    for (let c = parsed.startColumnIndex + 1; c < parsed.endColumnIndex; c++) {
      series.push({
        series: { sourceRange: { sources: [{ ...baseSource, startColumnIndex: c, endColumnIndex: c + 1 }] } },
      });
    }

    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addChart: {
            chart: {
              spec: {
                title,
                basicChart: {
                  chartType,
                  domains: [{ domain: { sourceRange: { sources: domainSources } } }],
                  series,
                },
              },
              position: { overlayPosition: { anchorCell: { sheetId, rowIndex: anchorRowIndex, columnIndex: anchorColumnIndex } } },
            },
          },
        }],
      },
    });
    const chart = res.data.replies?.[0]?.addChart?.chart;
    return textResult({ chartId: chart?.chartId, title: chart?.spec?.title });
  });

  server.tool("sheets_delete_chart", "Delete a chart from a spreadsheet", {
    spreadsheetId: z.string(),
    chartId: z.number(),
  }, async ({ spreadsheetId, chartId }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteEmbeddedObject: { objectId: chartId } }] },
    });
    return textResult({ success: true, chartId });
  });

  server.tool("sheets_replace_range_with_markdown", "Replace a range with markdown-formatted content (as plain text)", {
    spreadsheetId: z.string(),
    range: z.string(),
    markdown: z.string(),
  }, async ({ spreadsheetId, range, markdown }) => {
    const rows = markdown.split("\n").map((line) => [line]);
    const res = await api.spreadsheets.values.update({
      spreadsheetId, range,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
    return textResult({ updatedRange: res.data.updatedRange, updatedCells: res.data.updatedCells });
  });

  server.tool("sheets_batch_read", "Read several ranges from a spreadsheet in one call (values.batchGet). Use this instead of multiple sheets_read calls when you need a few different ranges at once.", {
    spreadsheetId: z.string(),
    ranges: z.array(z.string()).describe("A1 ranges to read (e.g. ['Sheet1!A1:C10', 'Totals!A1:B2'])"),
    valueRenderOption: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional().default("FORMATTED_VALUE"),
  }, async ({ spreadsheetId, ranges, valueRenderOption }) => {
    const res = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges, valueRenderOption });
    const valueRanges = res.data.valueRanges || [];
    const totalCells = valueRanges.reduce((sum, vr) => sum + countCells(vr.values), 0);
    assertCellCountWithinCap(totalCells, ranges.join(", "));
    return textResult({ valueRanges: valueRanges.map((vr) => ({ range: vr.range, values: vr.values })) });
  });

  server.tool("sheets_find_replace", "Find and replace text. Scope: whole spreadsheet by default, one sheet via sheetId, or a specific area via range (A1). Supports case-sensitive, whole-cell, and regex matching.", {
    spreadsheetId: z.string(),
    find: z.string(),
    replacement: z.string(),
    range: z.string().optional().describe("Limit to an A1 range (e.g. 'Sheet1!A1:C10'). Overrides sheetId."),
    sheetId: z.number().optional().describe("Limit to a single sheet by id. Omit both range and sheetId to search all sheets."),
    matchCase: z.boolean().optional(),
    matchEntireCell: z.boolean().optional(),
    searchByRegex: z.boolean().optional(),
  }, async (opts) => {
    const gridRange = opts.range ? await resolveGridRange(opts.spreadsheetId, opts.range, opts.sheetId) : undefined;
    const request = buildFindReplaceRequest({
      find: opts.find,
      replacement: opts.replacement,
      matchCase: opts.matchCase,
      matchEntireCell: opts.matchEntireCell,
      searchByRegex: opts.searchByRegex,
      sheetId: opts.sheetId,
      range: gridRange,
    });
    const res = await api.spreadsheets.batchUpdate({ spreadsheetId: opts.spreadsheetId, requestBody: { requests: [request] } });
    const fr = res.data.replies?.[0]?.findReplace;
    return textResult({
      occurrencesChanged: fr?.occurrencesChanged || 0,
      valuesChanged: fr?.valuesChanged || 0,
      rowsChanged: fr?.rowsChanged || 0,
      sheetsChanged: fr?.sheetsChanged || 0,
    });
  });

  server.tool("sheets_insert_rows", "Insert blank rows into a sheet, shifting existing rows down. Indices are zero-based and half-open: startIndex=2,endIndex=4 inserts 2 rows before row 3.", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startIndex: z.number().describe("Zero-based row index to insert before"),
    endIndex: z.number().describe("Exclusive end index; (endIndex - startIndex) rows are inserted"),
    inheritFromBefore: z.boolean().optional().default(false).describe("Inherit formatting from the row above (true) or below (false)"),
  }, async ({ spreadsheetId, sheetId, startIndex, endIndex, inheritFromBefore }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [buildInsertDimensionRequest({ sheetId, dimension: "ROWS", startIndex, endIndex, inheritFromBefore })] },
    });
    return textResult({ success: true, inserted: endIndex - startIndex, dimension: "ROWS" });
  });

  server.tool("sheets_insert_columns", "Insert blank columns into a sheet, shifting existing columns right. Indices are zero-based and half-open (column A = 0).", {
    spreadsheetId: z.string(),
    sheetId: z.number(),
    startIndex: z.number().describe("Zero-based column index to insert before (A=0, B=1, ...)"),
    endIndex: z.number().describe("Exclusive end index; (endIndex - startIndex) columns are inserted"),
    inheritFromBefore: z.boolean().optional().default(false).describe("Inherit formatting from the column to the left (true) or right (false)"),
  }, async ({ spreadsheetId, sheetId, startIndex, endIndex, inheritFromBefore }) => {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [buildInsertDimensionRequest({ sheetId, dimension: "COLUMNS", startIndex, endIndex, inheritFromBefore })] },
    });
    return textResult({ success: true, inserted: endIndex - startIndex, dimension: "COLUMNS" });
  });

  server.tool("sheets_merge_cells", "Merge a range of cells. Pass a sheet-qualified A1 range (e.g. 'Sheet1!A1:C1') or an A1 range plus sheetId. mergeType MERGE_ALL merges to one cell; MERGE_COLUMNS/MERGE_ROWS merge along one axis.", {
    spreadsheetId: z.string(),
    range: z.string().describe("A1 range to merge (e.g. 'Sheet1!A1:C1')"),
    sheetId: z.number().optional().describe("Sheet id, if the range isn't sheet-qualified"),
    mergeType: z.enum(["MERGE_ALL", "MERGE_COLUMNS", "MERGE_ROWS"]).optional().default("MERGE_ALL"),
  }, async ({ spreadsheetId, range, sheetId, mergeType }) => {
    const gridRange = await resolveGridRange(spreadsheetId, range, sheetId);
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [buildMergeCellsRequest({ range: gridRange, mergeType })] },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_set_borders", "Set borders on a cell range. Choose which sides to draw and the line style/color. Pass a sheet-qualified A1 range or an A1 range plus sheetId.", {
    spreadsheetId: z.string(),
    range: z.string().describe("A1 range (e.g. 'Sheet1!A1:C10')"),
    sheetId: z.number().optional().describe("Sheet id, if the range isn't sheet-qualified"),
    sides: z.array(z.enum(["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"])).optional().default(["top", "bottom", "left", "right"]).describe("Which borders to draw"),
    style: z.enum(["SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DASHED", "DOTTED", "DOUBLE", "NONE"]).optional().default("SOLID"),
    color: z.object({ red: z.number().optional(), green: z.number().optional(), blue: z.number().optional() }).optional().describe("RGB 0-1 components; defaults to black"),
  }, async ({ spreadsheetId, range, sheetId, sides, style, color }) => {
    const gridRange = await resolveGridRange(spreadsheetId, range, sheetId);
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [buildUpdateBordersRequest({ range: gridRange, style, color, sides: sides as BorderSide[] })] },
    });
    return textResult({ success: true });
  });

  server.tool("sheets_copy_sheet_to", "Copy a sheet (tab) into another spreadsheet (spreadsheets.sheets.copyTo). The copy lands in the destination with a name like 'Copy of <title>'.", {
    spreadsheetId: z.string().describe("Source spreadsheet id"),
    sheetId: z.number().describe("Id of the sheet to copy"),
    destinationSpreadsheetId: z.string().describe("Spreadsheet id to copy the sheet into"),
  }, async ({ spreadsheetId, sheetId, destinationSpreadsheetId }) => {
    const res = await api.spreadsheets.sheets.copyTo({
      spreadsheetId,
      sheetId,
      requestBody: { destinationSpreadsheetId },
    });
    return textResult({ sheetId: res.data.sheetId, title: res.data.title, index: res.data.index });
  });

  server.tool("sheets_add_named_range", "Create a named range (a reusable name for a cell range, usable in formulas). Pass a sheet-qualified A1 range or an A1 range plus sheetId.", {
    spreadsheetId: z.string(),
    name: z.string().describe("Name for the range (letters, digits, underscores; no spaces)"),
    range: z.string().describe("A1 range the name refers to (e.g. 'Sheet1!A1:A100')"),
    sheetId: z.number().optional().describe("Sheet id, if the range isn't sheet-qualified"),
  }, async ({ spreadsheetId, name, range, sheetId }) => {
    const gridRange = await resolveGridRange(spreadsheetId, range, sheetId);
    const res = await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [buildAddNamedRangeRequest({ name, range: gridRange })] },
    });
    const nr = res.data.replies?.[0]?.addNamedRange?.namedRange;
    return textResult({ namedRangeId: nr?.namedRangeId, name: nr?.name, range: nr?.range });
  });

  server.tool("sheets_list_named_ranges", "List the named ranges defined in a spreadsheet (id, name, and grid range).", {
    spreadsheetId: z.string(),
  }, async ({ spreadsheetId }) => {
    const res = await api.spreadsheets.get({ spreadsheetId, fields: "namedRanges" });
    return textResult({ namedRanges: res.data.namedRanges || [] });
  });
}
