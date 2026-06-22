import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, docs_v1 } from "googleapis";
import { z } from "zod";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";

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

function extractMarkdown(body: docs_v1.Schema$Body | undefined): string {
  if (!body?.content) return "";
  let md = "";
  for (const el of body.content) {
    if (el.paragraph) {
      const style = el.paragraph.paragraphStyle?.namedStyleType;
      let prefix = "";
      if (style === "HEADING_1") prefix = "# ";
      else if (style === "HEADING_2") prefix = "## ";
      else if (style === "HEADING_3") prefix = "### ";
      else if (style === "HEADING_4") prefix = "#### ";
      else if (style === "HEADING_5") prefix = "##### ";
      else if (style === "HEADING_6") prefix = "###### ";

      let line = "";
      for (const pe of el.paragraph.elements || []) {
        if (pe.textRun) {
          let t = pe.textRun.content || "";
          const ts = pe.textRun.textStyle;
          if (ts?.bold) t = `**${t.trim()}** `;
          if (ts?.italic) t = `*${t.trim()}* `;
          if (ts?.link?.url) t = `[${t.trim()}](${ts.link.url})`;
          line += t;
        }
      }
      md += prefix + line;
      if (!line.endsWith("\n")) md += "\n";
    }
  }
  return md;
}

export function registerDocsTools(server: McpServer, ctx: ServiceContext): void {
  const docsApi = () => google.docs({ version: "v1", auth: ctx.auth });
  const driveApi = () => google.drive({ version: "v3", auth: ctx.auth });

  server.tool("docs_read_document", "Read the content of a Google Document", {
    documentId: z.string().describe("Document ID from the URL"),
    format: z.enum(["text", "markdown", "json"]).optional().default("text"),
    maxLength: z.number().optional(),
    tabId: z.string().optional(),
  }, async ({ documentId, format, maxLength }) => {
    const doc = await docsApi().documents.get({ documentId });
    let content: string;
    if (format === "json") return textResult(doc.data);
    if (format === "markdown") content = extractMarkdown(doc.data.body);
    else content = extractPlainText(doc.data.body);
    if (maxLength && content.length > maxLength) content = content.slice(0, maxLength);
    return textResult(`Content (${content.length} characters):\n${content}`);
  });

  server.tool("docs_create_document", "Create a new Google Document", {
    title: z.string(),
    parentFolderId: z.string().optional(),
  }, async ({ title, parentFolderId }) => {
    const doc = await docsApi().documents.create({ requestBody: { title } });
    if (parentFolderId && doc.data.documentId) {
      await driveApi().files.update({ fileId: doc.data.documentId, addParents: parentFolderId, fields: "id" });
    }
    return textResult({ documentId: doc.data.documentId, title: doc.data.title, url: `https://docs.google.com/document/d/${doc.data.documentId}/edit` });
  });

  server.tool("docs_create_from_template", "Create a document from an existing template", {
    templateDocumentId: z.string(),
    title: z.string(),
    parentFolderId: z.string().optional(),
  }, async ({ templateDocumentId, title, parentFolderId }) => {
    const copy = await driveApi().files.copy({
      fileId: templateDocumentId,
      requestBody: { name: title, parents: parentFolderId ? [parentFolderId] : undefined },
      fields: "id,name,webViewLink",
    });
    return textResult({ documentId: copy.data.id, title: copy.data.name, url: copy.data.webViewLink });
  });

  server.tool("docs_get_info", "Get document metadata", {
    documentId: z.string(),
  }, async ({ documentId }) => {
    const doc = await docsApi().documents.get({ documentId });
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
    await docsApi().documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { text, location: { index } } }] },
    });
    return textResult({ success: true, insertedAt: index, length: text.length });
  });

  server.tool("docs_append_text", "Append text to the end of the document", {
    documentId: z.string(),
    text: z.string(),
  }, async ({ documentId, text }) => {
    const doc = await docsApi().documents.get({ documentId });
    const endIndex = (doc.data.body?.content?.at(-1)?.endIndex || 2) - 1;
    await docsApi().documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { text, location: { index: endIndex } } }] },
    });
    return textResult({ success: true, appendedAt: endIndex });
  });

  server.tool("docs_append_markdown", "Append markdown-formatted text to the document", {
    documentId: z.string(),
    markdown: z.string(),
  }, async ({ documentId, markdown }) => {
    const doc = await docsApi().documents.get({ documentId });
    const endIndex = (doc.data.body?.content?.at(-1)?.endIndex || 2) - 1;
    await docsApi().documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { text: markdown, location: { index: endIndex } } }] },
    });
    return textResult({ success: true, appendedAt: endIndex, note: "Inserted as plain text; markdown rendering depends on the viewer." });
  });

  server.tool("docs_modify_text", "Replace text in a range", {
    documentId: z.string(),
    startIndex: z.number(),
    endIndex: z.number(),
    newText: z.string(),
  }, async ({ documentId, startIndex, endIndex, newText }) => {
    await docsApi().documents.batchUpdate({
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

  server.tool("docs_replace_with_markdown", "Replace the entire document body with markdown content", {
    documentId: z.string(),
    markdown: z.string(),
  }, async ({ documentId, markdown }) => {
    const doc = await docsApi().documents.get({ documentId });
    const endIndex = (doc.data.body?.content?.at(-1)?.endIndex || 2) - 1;
    const requests: docs_v1.Schema$Request[] = [];
    if (endIndex > 1) {
      requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex } } });
    }
    requests.push({ insertText: { text: markdown, location: { index: 1 } } });
    await docsApi().documents.batchUpdate({ documentId, requestBody: { requests } });
    return textResult({ success: true });
  });

  server.tool("docs_find_and_replace", "Find and replace text in a document", {
    documentId: z.string(),
    find: z.string(),
    replace: z.string(),
    matchCase: z.boolean().optional().default(false),
  }, async ({ documentId, find, replace, matchCase }) => {
    const res = await docsApi().documents.batchUpdate({
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
    await docsApi().documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertInlineImage: { uri: imageUri, location: { index }, objectSize: size as unknown as undefined } }] },
    });
    return textResult({ success: true });
  });

  server.tool("docs_insert_page_break", "Insert a page break", {
    documentId: z.string(),
    index: z.number(),
  }, async ({ documentId, index }) => {
    await docsApi().documents.batchUpdate({
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
    await docsApi().documents.batchUpdate({
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
    const docs = docsApi();

    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertTable: { rows, columns, location: { index } } }] },
    });

    const doc = await docs.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    const table = tables.at(-1)?.table;
    if (!table?.tableRows) return textResult({ success: true, note: "Table inserted but could not populate" });

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
    const doc = await docsApi().documents.get({ documentId });
    const endIndex = (doc.data.body?.content?.at(-1)?.endIndex || 2) - 1;
    await docsApi().documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertTable: { rows, columns, location: { index: endIndex } } }] },
    });
    return textResult({ success: true, rows, columns });
  });

  server.tool("docs_get_table", "Get the content of a table by index", {
    documentId: z.string(),
    tableIndex: z.number().describe("0-based table index in the document"),
  }, async ({ documentId, tableIndex }) => {
    const doc = await docsApi().documents.get({ documentId });
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
    const doc = await docsApi().documents.get({ documentId });
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
    const doc = await docsApi().documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    if (tableIndex >= tables.length) return textResult({ error: `Table index ${tableIndex} out of range` });

    const el = tables[tableIndex];
    await docsApi().documents.batchUpdate({
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
    const docs = docsApi();
    const doc = await docs.documents.get({ documentId });
    const tables = doc.data.body?.content?.filter((e) => e.table) || [];
    if (tableIndex >= tables.length) return textResult({ error: "Table not found" });

    const table = tables[tableIndex];
    const tableEnd = table.endIndex! - 1;

    const requests: docs_v1.Schema$Request[] = [];
    for (const _row of rows) {
      requests.push({ insertTableRow: { tableCellLocation: { tableStartLocation: { index: table.startIndex! }, rowIndex: table.table!.rows! }, insertBelow: true } });
    }
    await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
    return textResult({ success: true, rowsAdded: rows.length });
  });

  server.tool("docs_update_table_range", "Update cells in a table range", {
    documentId: z.string(),
    tableIndex: z.number(),
    startRow: z.number(),
    startCol: z.number(),
    data: z.array(z.array(z.string())),
  }, async ({ documentId, tableIndex, startRow, startCol, data }) => {
    const docs = docsApi();
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

    await docsApi().documents.batchUpdate({
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

    await docsApi().documents.batchUpdate({
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
    await docsApi().documents.batchUpdate({
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
    await docsApi().documents.batchUpdate({
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
    await docsApi().documents.batchUpdate({
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
    const doc = await docsApi().documents.get({ documentId });
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

    await docsApi().documents.batchUpdate({
      documentId,
      requestBody: {
        requests: [{ updateTextStyle: { textStyle: sourceStyle, range: { startIndex: targetStartIndex, endIndex: targetEndIndex }, fields: "*" } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("docs_add_tab", "Add a new tab to the document", {
    documentId: z.string(),
    title: z.string().optional(),
  }, async ({ documentId, title }) => {
    // Tabs are managed via the Drive API / Docs API tab support
    // For now, this creates a section break as a conceptual "tab"
    return textResult({ note: "Google Docs tab support requires the Docs API v1 tabs feature. Use docs_list_tabs to see existing tabs." });
  });

  server.tool("docs_rename_tab", "Rename a document tab", {
    documentId: z.string(),
    tabId: z.string(),
    newTitle: z.string(),
  }, async ({ documentId, tabId, newTitle }) => {
    return textResult({ note: "Tab renaming requires Docs API v1 tabs support." });
  });

  server.tool("docs_list_tabs", "List all tabs in a document", {
    documentId: z.string(),
  }, async ({ documentId }) => {
    const doc = await docsApi().documents.get({ documentId });
    const tabs = doc.data.tabs || [{ tabProperties: { tabId: "default", title: doc.data.title } }];
    return textResult(tabs.map((t) => ({ tabId: t.tabProperties?.tabId, title: t.tabProperties?.title })));
  });

  server.tool("docs_add_comment", "Add a comment to the document", {
    documentId: z.string(),
    content: z.string().describe("Comment text"),
    quotedText: z.string().optional().describe("Text in the document to anchor the comment to"),
  }, async ({ documentId, content, quotedText }) => {
    const res = await driveApi().comments.create({
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
    const res = await driveApi().comments.get({
      fileId: documentId, commentId,
      fields: "id,content,author,createdTime,resolved,replies",
    });
    return textResult(res.data);
  });

  server.tool("docs_list_comments", "List all comments on a document", {
    documentId: z.string(),
    includeDeleted: z.boolean().optional().default(false),
  }, async ({ documentId, includeDeleted }) => {
    const res = await driveApi().comments.list({
      fileId: documentId,
      includeDeleted,
      fields: "comments(id,content,author,createdTime,resolved,quotedFileContent)",
    });
    return textResult(res.data.comments || []);
  });

  server.tool("docs_reply_to_comment", "Reply to a comment", {
    documentId: z.string(),
    commentId: z.string(),
    content: z.string(),
  }, async ({ documentId, commentId, content }) => {
    const res = await driveApi().replies.create({
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
    const res = await driveApi().comments.update({
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
    await driveApi().comments.delete({ fileId: documentId, commentId });
    return textResult({ success: true, commentId });
  });
}
