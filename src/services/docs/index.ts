import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, docs_v1, drive_v3 } from "googleapis";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";
import { concatMarkdownForAppend } from "./markdown.js";

function extractPlainText(body: docs_v1.Schema$Body | undefined): string {
  if (!body?.content) return "";
  let text = "";
  for (const el of body.content) {
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        if (pe.textRun?.content) text += pe.textRun.content;
      }
    }
    if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          text += extractPlainText(cell as unknown as docs_v1.Schema$Body) + "\t";
        }
        text += "\n";
      }
    }
  }
  return text;
}

/**
 * Locates the table created by an insertTable request at `location: {index}`.
 * Per the Docs API (Schema$InsertTableRequest.location): "A newline character
 * will be inserted before the inserted table, therefore the table start
 * index will be at the specified location index + 1." Returns undefined when
 * no table sits at that position — callers must treat that as an error, not
 * fall back to some other table.
 */
export function findInsertedTable(
  content: docs_v1.Schema$StructuralElement[] | undefined,
  insertionIndex: number
): docs_v1.Schema$Table | undefined {
  return content?.find((e) => e.table && e.startIndex === insertionIndex + 1)?.table ?? undefined;
}

interface TabStructureSummary {
  tabId: string | undefined;
  title: string | undefined;
  paragraphs: number;
  tables: number;
  images: number;
}

function countBodyElements(body: docs_v1.Schema$Body | undefined): { paragraphs: number; tables: number; images: number } {
  let paragraphs = 0;
  let tables = 0;
  let images = 0;
  for (const el of body?.content || []) {
    if (el.paragraph) {
      paragraphs++;
      for (const pe of el.paragraph.elements || []) {
        if (pe.inlineObjectElement) images++;
      }
    }
    if (el.table) tables++;
  }
  return { paragraphs, tables, images };
}

function collectTabSummaries(tabs: docs_v1.Schema$Tab[] | undefined): TabStructureSummary[] {
  const out: TabStructureSummary[] = [];
  for (const tab of tabs || []) {
    out.push({
      tabId: tab.tabProperties?.tabId ?? undefined,
      title: tab.tabProperties?.title ?? undefined,
      ...countBodyElements(tab.documentTab?.body),
    });
    out.push(...collectTabSummaries(tab.childTabs));
  }
  return out;
}

/**
 * Builds a small structural summary of a document (title/tabs/element
 * counts) in place of the full JSON body — used by docs_read_document when
 * the full JSON would blow past the size cap.
 */
export function summarizeDocumentStructure(doc: docs_v1.Schema$Document): {
  documentId: string | undefined;
  title: string | undefined;
  revisionId: string | undefined;
  tabCount: number;
  tabs: TabStructureSummary[];
} {
  const tabs = doc.tabs?.length
    ? collectTabSummaries(doc.tabs)
    : [{ tabId: undefined, title: doc.title ?? undefined, ...countBodyElements(doc.body) }];

  return {
    documentId: doc.documentId ?? undefined,
    title: doc.title ?? undefined,
    revisionId: doc.revisionId ?? undefined,
    tabCount: tabs.length,
    tabs,
  };
}

function findTab(tabs: docs_v1.Schema$Tab[] | undefined, tabId: string): docs_v1.Schema$Tab | undefined {
  for (const tab of tabs || []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const found = findTab(tab.childTabs, tabId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Picks which tab's body to read. Requires includeTabsContent: true on the
 * documents.get call, since that's what populates tab.documentTab.body
 * (without it, tabs only carry tabProperties, not content).
 */
function selectTabBody(doc: docs_v1.Schema$Document, tabId: string | undefined): docs_v1.Schema$Body | undefined {
  const tabs = doc.tabs;
  if (!tabs?.length) return doc.body;
  if (tabId) {
    const tab = findTab(tabs, tabId);
    if (tab?.documentTab?.body) return tab.documentTab.body;
  }
  return tabs[0]?.documentTab?.body;
}

// Default cap on docs_read_document output (all formats) so a large document
// can't blow past the model's context budget. Callers can raise it via the
// maxLength param when they genuinely need more.
const DEFAULT_MAX_LENGTH = 50_000;

export function registerDocsTools(server: McpServer, ctx: ServiceContext): void {
  const docsApi = google.docs({ version: "v1", auth: ctx.auth });
  const driveApi = google.drive({ version: "v3", auth: ctx.auth });

  server.tool("docs_read_document", "Read the content of a Google Document. format 'markdown' returns Google Drive's own native markdown export (full-fidelity headings, bold/italic, links, lists, tables) — not a lossy reconstruction. Note: markdown exports the WHOLE document; the tabId filter only applies to 'text'/'json'.", {
    documentId: z.string().describe("Document ID from the URL"),
    format: z.enum(["text", "markdown", "json"]).optional().default("text"),
    maxLength: z.number().optional().describe(`Max characters (text/markdown) or JSON-string length (json) to return before capping. Defaults to ${DEFAULT_MAX_LENGTH}.`),
    tabId: z.string().optional().describe("Read only this tab's content (see docs_list_tabs for tab IDs). Defaults to the document's first tab. Ignored for format 'markdown' (Drive exports the whole document)."),
  }, async ({ documentId, format, maxLength, tabId }) => {
    const cap = maxLength ?? DEFAULT_MAX_LENGTH;

    // Markdown uses Drive's native Docs->markdown converter for full fidelity,
    // rather than reconstructing markdown from the Docs JSON. Drive exports the
    // whole document (no per-tab export), so tabId is not honored here.
    if (format === "markdown") {
      const res = await driveApi.files.export(
        { fileId: documentId, mimeType: "text/markdown" },
        { responseType: "text" }
      );
      const content = typeof res.data === "string" ? res.data : String(res.data);
      const totalLength = content.length;
      const truncated = totalLength > cap;
      const shown = truncated ? content.slice(0, cap) : content;
      const header = truncated
        ? `Content (showing first ${cap} of ${totalLength} characters; pass a larger maxLength to see more):`
        : `Content (${totalLength} characters):`;
      return textResult(`${header}\n${shown}`);
    }

    const doc = await docsApi.documents.get({ documentId, includeTabsContent: true });

    if (format === "json") {
      const json = JSON.stringify(doc.data);
      if (json.length <= cap) return textResult(doc.data);
      return textResult({
        note: `Document JSON is ${json.length} characters, exceeding the ${cap}-character cap (maxLength). Returning a structural summary instead — use format: "text" or "markdown" for readable content, or pass a larger maxLength to force the full JSON.`,
        structure: summarizeDocumentStructure(doc.data),
      });
    }

    const body = selectTabBody(doc.data, tabId);
    const content = extractPlainText(body);
    const totalLength = content.length;
    const truncated = totalLength > cap;
    const shown = truncated ? content.slice(0, cap) : content;
    const header = truncated
      ? `Content (showing first ${cap} of ${totalLength} characters; pass a larger maxLength to see more):`
      : `Content (${totalLength} characters):`;
    return textResult(`${header}\n${shown}`);
  });

  server.tool("docs_create_document", "Create a new Google Document", {
    title: z.string(),
    parentFolderId: z.string().optional(),
  }, async ({ title, parentFolderId }) => {
    const doc = await docsApi.documents.create({ requestBody: { title } });
    if (parentFolderId && doc.data.documentId) {
      await driveApi.files.update({ fileId: doc.data.documentId, addParents: parentFolderId, fields: "id" });
    }
    return textResult({ documentId: doc.data.documentId, title: doc.data.title, url: `https://docs.google.com/document/d/${doc.data.documentId}/edit` });
  });

  server.tool("docs_create_from_template", "Create a document from an existing template", {
    templateDocumentId: z.string(),
    title: z.string(),
    parentFolderId: z.string().optional(),
  }, async ({ templateDocumentId, title, parentFolderId }) => {
    const copy = await driveApi.files.copy({
      fileId: templateDocumentId,
      requestBody: { name: title, parents: parentFolderId ? [parentFolderId] : undefined },
      fields: "id,name,webViewLink",
    });
    return textResult({ documentId: copy.data.id, title: copy.data.name, url: copy.data.webViewLink });
  });

  server.tool("docs_get_info", "Get document metadata", {
    documentId: z.string(),
  }, async ({ documentId }) => {
    const doc = await docsApi.documents.get({ documentId });
    return textResult({
      documentId: doc.data.documentId,
      title: doc.data.title,
      revisionId: doc.data.revisionId,
      url: `https://docs.google.com/document/d/${doc.data.documentId}/edit`,
    });
  });

  server.tool("docs_insert_text", "Insert text at a specific position", {
    documentId: z.string(),
    text: z.string(),
    index: z.number().describe("Character index to insert at (1 = start of body)"),
  }, async ({ documentId, text, index }) => {
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { text, location: { index } } }] },
    });
    return textResult({ success: true, insertedAt: index, length: text.length });
  });

  server.tool("docs_append_text", "Append text to the end of the document", {
    documentId: z.string(),
    text: z.string(),
  }, async ({ documentId, text }) => {
    const doc = await docsApi.documents.get({ documentId, fields: "body.content(endIndex)" });
    const endIndex = (doc.data.body?.content?.at(-1)?.endIndex || 2) - 1;
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { text, location: { index: endIndex } } }] },
    });
    return textResult({ success: true, appendedAt: endIndex });
  });

  server.tool("docs_append_markdown", "Append markdown to the end of a document, rendered as NATIVE Google Docs content (real headings, bold/italic, links, lists, tables) via Drive's markdown converter. Works by exporting the current doc to markdown, concatenating your markdown, and re-importing the whole thing. CAVEAT: because this rewrites the entire document, comments, suggestions, and named anchors/bookmarks in the existing content are NOT preserved. For surgical edits that keep those, use docs_insert_text / docs_apply_* instead.", {
    documentId: z.string(),
    markdown: z.string(),
  }, async ({ documentId, markdown }) => {
    const exported = await driveApi.files.export(
      { fileId: documentId, mimeType: "text/markdown" },
      { responseType: "text" }
    );
    const existing = typeof exported.data === "string" ? exported.data : String(exported.data);
    const combined = concatMarkdownForAppend(existing, markdown);
    await driveApi.files.update({
      fileId: documentId,
      media: { mimeType: "text/markdown", body: combined },
    });
    return textResult({ success: true, note: "Appended as native Docs content. Full-document re-import: comments/anchors in existing content may not survive." });
  });

  server.tool("docs_modify_text", "Replace text in a range", {
    documentId: z.string(),
    startIndex: z.number(),
    endIndex: z.number(),
    newText: z.string(),
  }, async ({ documentId, startIndex, endIndex, newText }) => {
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [
          { deleteContentRange: { range: { startIndex, endIndex } } },
          { insertText: { text: newText, location: { index: startIndex } } },
        ],
      },
    });
    return textResult({ success: true });
  });

  server.tool("docs_replace_with_markdown", "Replace the ENTIRE document with markdown, rendered as native Google Docs content (real headings, bold/italic, links, lists, tables) via Drive's markdown converter — not plain text. This overwrites all existing content. CAVEAT: because it re-imports the whole file, existing comments, suggestions, and named anchors/bookmarks are NOT preserved. Best for generating a document from scratch or wholesale rewrites; use docs_insert_text / docs_modify_text / docs_apply_* for edits that must keep those.", {
    documentId: z.string(),
    markdown: z.string(),
  }, async ({ documentId, markdown }) => {
    await driveApi.files.update({
      fileId: documentId,
      media: { mimeType: "text/markdown", body: markdown },
    });
    return textResult({ success: true, note: "Replaced with native Docs content converted from markdown. Comments/anchors from prior content may not survive." });
  });

  server.tool("docs_find_and_replace", "Find and replace text in a document", {
    documentId: z.string(),
    find: z.string(),
    replace: z.string(),
    matchCase: z.boolean().optional().default(false),
  }, async ({ documentId, find, replace, matchCase }) => {
    const res = await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } }] },
    });
    const count = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
    return textResult({ success: true, occurrencesChanged: count });
  });

  server.tool("docs_insert_image", "Insert an image into the document", {
    documentId: z.string(),
    imageUri: z.string().describe("Public URL of the image"),
    index: z.number().describe("Character index to insert at"),
    width: z.number().optional().describe("Width in points"),
    height: z.number().optional().describe("Height in points"),
  }, async ({ documentId, imageUri, index, width, height }) => {
    const size = width && height ? { width: { magnitude: width, unit: "PT" }, height: { magnitude: height, unit: "PT" } } : undefined;
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertInlineImage: { uri: imageUri, location: { index }, objectSize: size as unknown as undefined } }] },
    });
    return textResult({ success: true });
  });

  server.tool("docs_insert_page_break", "Insert a page break", {
    documentId: z.string(),
    index: z.number(),
  }, async ({ documentId, index }) => {
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertPageBreak: { location: { index } } }] },
    });
    return textResult({ success: true });
  });

  server.tool("docs_insert_table", "Insert an empty table", {
    documentId: z.string(),
    rows: z.number(),
    columns: z.number(),
    index: z.number(),
  }, async ({ documentId, rows, columns, index }) => {
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertTable: { rows, columns, location: { index } } }] },
    });
    return textResult({ success: true, rows, columns });
  });

  server.tool("docs_insert_table_with_data", "Insert a table pre-populated with data", {
    documentId: z.string(),
    data: z.array(z.array(z.string())).describe("2D array of cell values"),
    index: z.number(),
  }, async ({ documentId, data, index }) => {
    const rows = data.length;
    const columns = data[0]?.length || 1;
    const docs = docsApi;

    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertTable: { rows, columns, location: { index } } }] },
    });

    const doc = await docs.documents.get({ documentId });
    const table = findInsertedTable(doc.data.body?.content, index);
    if (!table?.tableRows) {
      throw new Error(`Table was inserted at index ${index} but could not be located to populate (expected a table with startIndex ${index + 1}). The table exists but is empty.`);
    }

    const requests: docs_v1.Schema$Request[] = [];
    for (let r = table.tableRows.length - 1; r >= 0; r--) {
      const cells = table.tableRows[r].tableCells || [];
      for (let c = cells.length - 1; c >= 0; c--) {
        const cellContent = cells[c].content;
        if (cellContent?.[0]?.startIndex !== undefined && data[r]?.[c]) {
          requests.push({ insertText: { text: data[r][c], location: { index: cellContent[0].startIndex } } });
        }
      }
    }

    if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
    return textResult({ success: true, rows, columns });
  });

  server.tool("docs_create_table", "Create a table at the end of the document", {
    documentId: z.string(),
    rows: z.number(),
    columns: z.number(),
  }, async ({ documentId, rows, columns }) => {
    const doc = await docsApi.documents.get({ documentId, fields: "body.content(endIndex)" });
    const endIndex = (doc.data.body?.content?.at(-1)?.endIndex || 2) - 1;
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertTable: { rows, columns, location: { index: endIndex } } }] },
    });
    return textResult({ success: true, rows, columns });
  });

  server.tool("docs_get_table", "Get the content of a table by index", {
    documentId: z.string(),
    tableIndex: z.number().describe("0-based table index in the document"),
  }, async ({ documentId, tableIndex }) => {
    const doc = await docsApi.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    if (tableIndex >= tables.length) return textResult({ error: `Table index ${tableIndex} out of range (${tables.length} tables)` });

    const table = tables[tableIndex].table!;
    const data = table.tableRows?.map((row) =>
      row.tableCells?.map((cell) => extractPlainText(cell as unknown as docs_v1.Schema$Body).trim()) || []
    ) || [];
    return textResult({ tableIndex, rows: data.length, columns: data[0]?.length || 0, data });
  });

  server.tool("docs_list_tables", "List all tables in a document", {
    documentId: z.string(),
  }, async ({ documentId }) => {
    const doc = await docsApi.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    return textResult(tables.map((t, i) => ({
      index: i,
      rows: t.table?.rows,
      columns: t.table?.columns,
      startIndex: t.startIndex,
      endIndex: t.endIndex,
    })));
  });

  server.tool("docs_delete_table", "Delete a table by index", {
    documentId: z.string(),
    tableIndex: z.number(),
  }, async ({ documentId, tableIndex }) => {
    const doc = await docsApi.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    if (tableIndex >= tables.length) return textResult({ error: `Table index ${tableIndex} out of range` });

    const el = tables[tableIndex];
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ deleteContentRange: { range: { startIndex: el.startIndex!, endIndex: el.endIndex! } } }] },
    });
    return textResult({ success: true });
  });

  server.tool("docs_append_table_rows", "Append rows to an existing table", {
    documentId: z.string(),
    tableIndex: z.number(),
    rows: z.array(z.array(z.string())),
  }, async ({ documentId, tableIndex, rows }) => {
    if (rows.length === 0) return textResult({ success: true, rowsAdded: 0 });

    const docs = docsApi;
    const doc = await docs.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    if (tableIndex >= tables.length) return textResult({ error: "Table not found" });

    const tableElement = tables[tableIndex];
    const tableStartIndex = tableElement.startIndex!;
    const existingRowCount = tableElement.table!.rows!;
    if (existingRowCount < 1) return textResult({ error: "Table has no rows to anchor the insertion to" });

    // Insert `rows.length` empty rows, each anchored below the previous
    // last row (existingRowCount - 1 + i), so they land in order at the
    // end of the table.
    const insertRequests: docs_v1.Schema$Request[] = rows.map((_row, i) => ({
      insertTableRow: {
        tableCellLocation: {
          tableStartLocation: { index: tableStartIndex },
          rowIndex: existingRowCount - 1 + i,
        },
        insertBelow: true,
      },
    }));
    await docs.documents.batchUpdate({ documentId, requestBody: { requests: insertRequests } });

    // Re-fetch to get the real cell start indexes for the newly inserted
    // (empty) rows, then populate them.
    const updatedDoc = await docs.documents.get({ documentId });
    const updatedTables = updatedDoc.data.body?.content?.filter((e) => e.table) || [];
    const updatedTableRows = updatedTables.find((t) => t.startIndex === tableStartIndex)?.table?.tableRows || [];

    const textRequests: docs_v1.Schema$Request[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const tableRow = updatedTableRows[existingRowCount + i];
      const cells = tableRow?.tableCells || [];
      for (let c = cells.length - 1; c >= 0; c--) {
        const cellText = rows[i][c];
        const cellStartIndex = cells[c].content?.[0]?.startIndex;
        if (cellText && cellStartIndex !== undefined) {
          textRequests.push({ insertText: { text: cellText, location: { index: cellStartIndex } } });
        }
      }
    }
    if (textRequests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests: textRequests } });

    return textResult({ success: true, rowsAdded: rows.length });
  });

  server.tool("docs_update_table_range", "Update cells in a table range", {
    documentId: z.string(),
    tableIndex: z.number(),
    startRow: z.number(),
    startCol: z.number(),
    data: z.array(z.array(z.string())),
  }, async ({ documentId, tableIndex, startRow, startCol, data }) => {
    const docs = docsApi;
    const doc = await docs.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    if (tableIndex >= tables.length) return textResult({ error: "Table not found" });

    const table = tables[tableIndex].table!;
    const requests: docs_v1.Schema$Request[] = [];

    for (let r = data.length - 1; r >= 0; r--) {
      for (let c = data[r].length - 1; c >= 0; c--) {
        const row = table.tableRows?.[startRow + r];
        const cell = row?.tableCells?.[startCol + c];
        if (cell?.content) {
          const start = cell.content[0].startIndex!;
          const end = cell.content.at(-1)!.endIndex! - 1;
          if (end > start) {
            requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: end } } });
          }
          requests.push({ insertText: { text: data[r][c], location: { index: start } } });
        }
      }
    }

    if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
    return textResult({ success: true });
  });

  server.tool("docs_apply_text_style", "Apply text styling to a range", {
    documentId: z.string(),
    startIndex: z.number(),
    endIndex: z.number(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    fontSize: z.number().optional().describe("Font size in points"),
    fontFamily: z.string().optional(),
    foregroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional(),
    link: z.string().optional().describe("URL to link to"),
  }, async ({ documentId, startIndex, endIndex, bold, italic, underline, strikethrough, fontSize, fontFamily, foregroundColor, link }) => {
    const textStyle: Record<string, unknown> = {};
    const fields: string[] = [];
    if (bold !== undefined) { textStyle.bold = bold; fields.push("bold"); }
    if (italic !== undefined) { textStyle.italic = italic; fields.push("italic"); }
    if (underline !== undefined) { textStyle.underline = underline; fields.push("underline"); }
    if (strikethrough !== undefined) { textStyle.strikethrough = strikethrough; fields.push("strikethrough"); }
    if (fontSize) { textStyle.fontSize = { magnitude: fontSize, unit: "PT" }; fields.push("fontSize"); }
    if (fontFamily) { textStyle.weightedFontFamily = { fontFamily }; fields.push("weightedFontFamily"); }
    if (foregroundColor) { textStyle.foregroundColor = { color: { rgbColor: foregroundColor } }; fields.push("foregroundColor"); }
    if (link) { textStyle.link = { url: link }; fields.push("link"); }

    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ updateTextStyle: { textStyle, range: { startIndex, endIndex }, fields: fields.join(",") } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("docs_apply_paragraph_style", "Apply paragraph styling to a range", {
    documentId: z.string(),
    startIndex: z.number(),
    endIndex: z.number(),
    namedStyleType: z.enum(["NORMAL_TEXT", "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"]).optional(),
    alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional(),
    lineSpacing: z.number().optional().describe("Line spacing (100 = single, 200 = double)"),
    spaceAbove: z.number().optional().describe("Space above in points"),
    spaceBelow: z.number().optional().describe("Space below in points"),
  }, async ({ documentId, startIndex, endIndex, namedStyleType, alignment, lineSpacing, spaceAbove, spaceBelow }) => {
    const paragraphStyle: Record<string, unknown> = {};
    const fields: string[] = [];
    if (namedStyleType) { paragraphStyle.namedStyleType = namedStyleType; fields.push("namedStyleType"); }
    if (alignment) { paragraphStyle.alignment = alignment; fields.push("alignment"); }
    if (lineSpacing) { paragraphStyle.lineSpacing = lineSpacing; fields.push("lineSpacing"); }
    if (spaceAbove !== undefined) { paragraphStyle.spaceAbove = { magnitude: spaceAbove, unit: "PT" }; fields.push("spaceAbove"); }
    if (spaceBelow !== undefined) { paragraphStyle.spaceBelow = { magnitude: spaceBelow, unit: "PT" }; fields.push("spaceBelow"); }

    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ updateParagraphStyle: { paragraphStyle, range: { startIndex, endIndex }, fields: fields.join(",") } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("docs_insert_date", "Insert a real Google Docs date smart-chip (dateElement pill) at an index. The index must be inside an existing paragraph (not at a table start). Default display format is 'MMM d, y' (e.g. 'Jun 22, 2026').", {
    documentId: z.string(),
    index: z.number().describe("Character index to insert the date pill at; must be within an existing paragraph"),
    timestamp: z.string().describe("Point in time as RFC3339 (e.g. '2026-06-22T12:00:00Z'). Interpreted in UTC unless timeZoneId is set."),
    dateFormat: z.string().optional().describe("e.g. DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED (default), DATE_FORMAT_ISO8601"),
    timeFormat: z.string().optional().describe("e.g. TIME_FORMAT_DISABLED (default), TIME_FORMAT_HOUR_MINUTE"),
    timeZoneId: z.string().optional().describe("IANA tz, e.g. 'America/New_York'. Defaults to etc/UTC."),
    locale: z.string().optional().describe("CLDR locale, e.g. 'en_US'"),
  }, async ({ documentId, index, timestamp, dateFormat, timeFormat, timeZoneId, locale }) => {
    const dateElementProperties: docs_v1.Schema$DateElementProperties = { timestamp };
    if (dateFormat) dateElementProperties.dateFormat = dateFormat;
    if (timeFormat) dateElementProperties.timeFormat = timeFormat;
    if (timeZoneId) dateElementProperties.timeZoneId = timeZoneId;
    if (locale) dateElementProperties.locale = locale;
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertDate: { location: { index }, dateElementProperties } }] },
    });
    return textResult({ success: true, index, timestamp });
  });

  server.tool("docs_create_paragraph_bullets", "Apply a bullet list to a range. Nesting level is set deterministically by LEADING TABS on each paragraph (0 tabs = top level, 1 tab = one level deeper, etc.); the tabs are consumed. Use this for reliable heading(L0)/content(L1) nesting instead of relying on insert-time list inheritance.", {
    documentId: z.string(),
    startIndex: z.number(),
    endIndex: z.number(),
    bulletPreset: z.string().optional().default("BULLET_DISC_CIRCLE_SQUARE").describe("Glyph preset, e.g. BULLET_DISC_CIRCLE_SQUARE, BULLET_CHECKBOX, NUMBERED_DECIMAL_ALPHA_ROMAN"),
  }, async ({ documentId, startIndex, endIndex, bulletPreset }) => {
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ createParagraphBullets: { range: { startIndex, endIndex }, bulletPreset } }] },
    });
    return textResult({ success: true });
  });

  server.tool("docs_delete_paragraph_bullets", "Remove bullets/numbering from the paragraphs in a range (the paragraphs and their text remain; only the list formatting is stripped).", {
    documentId: z.string(),
    startIndex: z.number(),
    endIndex: z.number(),
  }, async ({ documentId, startIndex, endIndex }) => {
    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ deleteParagraphBullets: { range: { startIndex, endIndex } } }] },
    });
    return textResult({ success: true });
  });

  server.tool("docs_copy_formatting", "Copy formatting from a source range to a target range", {
    documentId: z.string(),
    sourceStartIndex: z.number(),
    sourceEndIndex: z.number(),
    targetStartIndex: z.number(),
    targetEndIndex: z.number(),
  }, async ({ documentId, sourceStartIndex, sourceEndIndex, targetStartIndex, targetEndIndex }) => {
    const doc = await docsApi.documents.get({ documentId });
    let sourceStyle: docs_v1.Schema$TextStyle | undefined;
    for (const el of doc.data.body?.content || []) {
      for (const pe of el.paragraph?.elements || []) {
        if (pe.startIndex != null && pe.startIndex >= sourceStartIndex && (pe.endIndex || 0) <= sourceEndIndex) {
          sourceStyle = pe.textRun?.textStyle;
          break;
        }
      }
      if (sourceStyle) break;
    }
    if (!sourceStyle) return textResult({ error: "Could not find source text style" });

    await docsApi.documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ updateTextStyle: { textStyle: sourceStyle, range: { startIndex: targetStartIndex, endIndex: targetEndIndex }, fields: "*" } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("docs_list_tabs", "List all tabs in a document", {
    documentId: z.string(),
  }, async ({ documentId }) => {
    const doc = await docsApi.documents.get({ documentId });
    const tabs = doc.data.tabs || [{ tabProperties: { tabId: "default", title: doc.data.title } }];
    return textResult(tabs.map((t) => ({ tabId: t.tabProperties?.tabId, title: t.tabProperties?.title })));
  });

  server.tool("docs_add_comment", "Add a comment to the document", {
    documentId: z.string(),
    content: z.string().describe("Comment text"),
    quotedText: z.string().optional().describe("Text in the document to anchor the comment to"),
  }, async ({ documentId, content, quotedText }) => {
    const res = await driveApi.comments.create({
      fileId: documentId,
      fields: "id,content,author,createdTime",
      requestBody: { content, quotedFileContent: quotedText ? { value: quotedText } : undefined },
    });
    return textResult(res.data);
  });

  server.tool("docs_get_comment", "Get a specific comment", {
    documentId: z.string(),
    commentId: z.string(),
  }, async ({ documentId, commentId }) => {
    const res = await driveApi.comments.get({
      fileId: documentId, commentId,
      fields: "id,content,author,createdTime,resolved,replies",
    });
    return textResult(res.data);
  });

  server.tool("docs_list_comments", "List all comments on a document", {
    documentId: z.string(),
    includeDeleted: z.boolean().optional().default(false),
  }, async ({ documentId, includeDeleted }) => {
    const drive = driveApi;
    const comments: drive_v3.Schema$Comment[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.comments.list({
        fileId: documentId,
        includeDeleted,
        pageSize: 100,
        pageToken,
        fields: "nextPageToken,comments(id,content,author,createdTime,resolved,quotedFileContent)",
      });
      comments.push(...(res.data.comments || []));
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    return textResult(comments);
  });

  server.tool("docs_reply_to_comment", "Reply to a comment", {
    documentId: z.string(),
    commentId: z.string(),
    content: z.string(),
  }, async ({ documentId, commentId, content }) => {
    const res = await driveApi.replies.create({
      fileId: documentId, commentId,
      fields: "id,content,author,createdTime",
      requestBody: { content },
    });
    return textResult(res.data);
  });

  server.tool("docs_resolve_comment", "Resolve a comment", {
    documentId: z.string(),
    commentId: z.string(),
  }, async ({ documentId, commentId }) => {
    const res = await driveApi.comments.update({
      fileId: documentId, commentId,
      fields: "id,resolved",
      requestBody: { resolved: true },
    });
    return textResult({ commentId, resolved: true });
  });

  server.tool("docs_delete_comment", "Delete a comment", {
    documentId: z.string(),
    commentId: z.string(),
  }, async ({ documentId, commentId }) => {
    await driveApi.comments.delete({ fileId: documentId, commentId });
    return textResult({ success: true, commentId });
  });
}
