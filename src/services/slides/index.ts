import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google, slides_v1 } from "googleapis";
import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ServiceContext } from "../../types.js";
import { textResult } from "../../utils/formatting.js";
import {
  ptToEmu,
  buildCreateSlideRequest,
  parseBatchRequests,
  buildTemplateReplacementRequests,
  buildStyleShapeRequest,
  buildSetBackgroundRequests,
  computeAlignedTransforms,
  textContentLength,
  type PlaceholderSpec,
  type AlignInputElement,
  type BackgroundFill,
} from "./builders.js";

// The Slides API PredefinedLayout enum (minus PREDEFINED_LAYOUT_UNSPECIFIED).
// Used by slides_add_slide so callers pick a real theme layout instead of a
// bare BLANK slide + floating boxes.
const PREDEFINED_LAYOUTS = [
  "BLANK",
  "CAPTION_ONLY",
  "TITLE",
  "TITLE_AND_BODY",
  "TITLE_AND_TWO_COLUMNS",
  "TITLE_ONLY",
  "SECTION_HEADER",
  "SECTION_TITLE_AND_DESCRIPTION",
  "ONE_COLUMN_TEXT",
  "MAIN_POINT",
  "BIG_NUMBER",
] as const;

/** Summarizes the placeholder shapes on a slide page (objectId + type + index). */
function placeholderMap(page: slides_v1.Schema$Page | undefined): Array<{ objectId: string | null | undefined; type: string | null | undefined; index: number }> {
  const out: Array<{ objectId: string | null | undefined; type: string | null | undefined; index: number }> = [];
  for (const pe of page?.pageElements ?? []) {
    const ph = pe.shape?.placeholder;
    if (ph) out.push({ objectId: pe.objectId, type: ph.type, index: ph.index ?? 0 });
  }
  return out;
}

// Random suffix appended to Date.now()-based element IDs so two elements
// created within the same millisecond (a real risk under concurrent or
// scripted calls) never collide.
function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

function tempPdfPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}.pdf`);
}

export function registerSlidesTools(server: McpServer, ctx: ServiceContext): void {
  const api = google.slides({ version: "v1", auth: ctx.auth });
  const driveApi = google.drive({ version: "v3", auth: ctx.auth });

  server.tool("slides_create_presentation", "Create a new Google Slides presentation", {
    title: z.string(),
  }, async ({ title }) => {
    const res = await api.presentations.create({ requestBody: { title } });
    return textResult({
      presentationId: res.data.presentationId,
      title: res.data.title,
      url: `https://docs.google.com/presentation/d/${res.data.presentationId}/edit`,
      slides: res.data.slides?.map((s) => s.objectId),
    });
  });

  server.tool("slides_get_presentation", "Get presentation metadata and slide list", {
    presentationId: z.string(),
  }, async ({ presentationId }) => {
    const res = await api.presentations.get({ presentationId });
    return textResult({
      presentationId: res.data.presentationId,
      title: res.data.title,
      slideCount: res.data.slides?.length,
      slides: res.data.slides?.map((s, i) => ({
        index: i,
        objectId: s.objectId,
        elements: s.pageElements?.length || 0,
      })),
      url: `https://docs.google.com/presentation/d/${res.data.presentationId}/edit`,
    });
  });

  server.tool("slides_add_slide", "Add a slide, ideally using a real theme LAYOUT so it inherits the deck's fonts/colors/positioning — prefer this over a BLANK slide with floating text boxes. Pass predefinedLayout (e.g. TITLE_AND_BODY) OR a layoutId from slides_list_layouts. The response includes the created slide's placeholders (objectId + type); fill them with slides_fill_placeholder. Pass `placeholders` to assign your own predictable placeholder object IDs.", {
    presentationId: z.string(),
    insertionIndex: z.number().optional().describe("Position to insert (0 = first). Omit to append at the end."),
    predefinedLayout: z.enum(PREDEFINED_LAYOUTS).optional().describe("A predefined theme layout. Common: TITLE (cover), TITLE_AND_BODY (content), SECTION_HEADER, TITLE_ONLY, BLANK."),
    layoutId: z.string().optional().describe("Object ID of a layout in this presentation (from slides_list_layouts). Takes effect only if predefinedLayout is not set."),
    placeholders: z.array(z.object({
      type: z.string().describe("Placeholder type on the layout, e.g. TITLE, BODY, SUBTITLE, CENTERED_TITLE"),
      index: z.number().optional().describe("Placeholder index (default 0)"),
      objectId: z.string().describe("Object ID to assign to this placeholder on the new slide"),
    })).optional().describe("Assign your own object IDs to the layout's placeholders. Only valid together with a layout. If omitted, IDs are auto-generated and returned in the response."),
  }, async ({ presentationId, insertionIndex, predefinedLayout, layoutId, placeholders }) => {
    const slideObjectId = uniqueId("slide");
    const request = buildCreateSlideRequest({
      slideObjectId,
      predefinedLayout,
      layoutId,
      insertionIndex,
      placeholders: placeholders as PlaceholderSpec[] | undefined,
    });
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests: [request] } });

    // Read the created slide back so we can return an accurate placeholder map
    // (createSlide's reply only carries the slide's own object ID, not its
    // placeholders' IDs when they were auto-generated).
    const pres = await api.presentations.get({
      presentationId,
      fields: "slides(objectId,pageElements(objectId,shape(placeholder(type,index))))",
    });
    const page = pres.data.slides?.find((s) => s.objectId === slideObjectId);
    return textResult({ slideId: slideObjectId, layout: predefinedLayout ?? layoutId, placeholders: placeholderMap(page) });
  });

  server.tool("slides_delete_slide", "Delete a slide from a presentation", {
    presentationId: z.string(),
    slideObjectId: z.string(),
  }, async ({ presentationId, slideObjectId }) => {
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: [{ deleteObject: { objectId: slideObjectId } }] },
    });
    return textResult({ success: true, slideObjectId });
  });

  server.tool("slides_duplicate_slide", "Duplicate an existing slide", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    insertionIndex: z.number().optional(),
  }, async ({ presentationId, slideObjectId, insertionIndex }) => {
    const res = await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{ duplicateObject: { objectId: slideObjectId } }],
      },
    });
    const newId = res.data.replies?.[0]?.duplicateObject?.objectId;
    return textResult({ newSlideId: newId });
  });

  server.tool("slides_reorder_slides", "Reorder slides in a presentation", {
    presentationId: z.string(),
    slideObjectIds: z.array(z.string()).describe("Slide IDs in the desired order"),
    insertionIndex: z.number().describe("Index to move slides to"),
  }, async ({ presentationId, slideObjectIds, insertionIndex }) => {
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{ updateSlidesPosition: { slideObjectIds, insertionIndex } }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("slides_add_text", "Add a text box to a slide", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    text: z.string(),
    x: z.number().optional().default(100).describe("X position in EMU or points"),
    y: z.number().optional().default(100),
    width: z.number().optional().default(400),
    height: z.number().optional().default(50),
  }, async ({ presentationId, slideObjectId, text, x, y, width, height }) => {
    const boxId = uniqueId("textbox");
    const emu = (pts: number) => pts * 12700;
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [
          {
            createShape: {
              objectId: boxId,
              shapeType: "TEXT_BOX",
              elementProperties: {
                pageObjectId: slideObjectId,
                size: { width: { magnitude: emu(width), unit: "EMU" }, height: { magnitude: emu(height), unit: "EMU" } },
                transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: "EMU" },
              },
            },
          },
          {
            insertText: { objectId: boxId, text, insertionIndex: 0 },
          },
        ],
      },
    });
    return textResult({ objectId: boxId });
  });

  server.tool("slides_add_image", "Add an image to a slide", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    imageUrl: z.string().describe("Public URL of the image"),
    x: z.number().optional().default(100),
    y: z.number().optional().default(100),
    width: z.number().optional().default(300),
    height: z.number().optional().default(200),
  }, async ({ presentationId, slideObjectId, imageUrl, x, y, width, height }) => {
    const imageId = uniqueId("image");
    const emu = (pts: number) => pts * 12700;
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{
          createImage: {
            objectId: imageId,
            url: imageUrl,
            elementProperties: {
              pageObjectId: slideObjectId,
              size: { width: { magnitude: emu(width), unit: "EMU" }, height: { magnitude: emu(height), unit: "EMU" } },
              transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: "EMU" },
            },
          },
        }],
      },
    });
    return textResult({ objectId: imageId });
  });

  server.tool("slides_add_shape", "Add a shape to a slide", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    shapeType: z.string().describe("Shape type (e.g., RECTANGLE, ELLIPSE, ARROW_EAST)"),
    x: z.number().optional().default(100),
    y: z.number().optional().default(100),
    width: z.number().optional().default(200),
    height: z.number().optional().default(100),
  }, async ({ presentationId, slideObjectId, shapeType, x, y, width, height }) => {
    const shapeId = uniqueId("shape");
    const emu = (pts: number) => pts * 12700;
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{
          createShape: {
            objectId: shapeId,
            shapeType,
            elementProperties: {
              pageObjectId: slideObjectId,
              size: { width: { magnitude: emu(width), unit: "EMU" }, height: { magnitude: emu(height), unit: "EMU" } },
              transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: "EMU" },
            },
          },
        }],
      },
    });
    return textResult({ objectId: shapeId });
  });

  server.tool("slides_add_video", "Embed a video on a slide", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    videoUrl: z.string().describe("YouTube video URL"),
    x: z.number().optional().default(100),
    y: z.number().optional().default(100),
    width: z.number().optional().default(400),
    height: z.number().optional().default(300),
  }, async ({ presentationId, slideObjectId, videoUrl, x, y, width, height }) => {
    const videoId = uniqueId("video");
    const emu = (pts: number) => pts * 12700;
    const ytMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (!ytMatch) return textResult({ error: "Could not extract YouTube video ID from URL" });

    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{
          createVideo: {
            objectId: videoId,
            source: "YOUTUBE",
            id: ytMatch[1],
            elementProperties: {
              pageObjectId: slideObjectId,
              size: { width: { magnitude: emu(width), unit: "EMU" }, height: { magnitude: emu(height), unit: "EMU" } },
              transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: "EMU" },
            },
          },
        }],
      },
    });
    return textResult({ objectId: videoId });
  });

  server.tool("slides_insert_audio_link", "Insert a hyperlink to an audio file on a slide", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    audioUrl: z.string(),
    linkText: z.string().optional().default("Audio Link"),
    x: z.number().optional().default(100),
    y: z.number().optional().default(100),
  }, async ({ presentationId, slideObjectId, audioUrl, linkText, x, y }) => {
    const boxId = uniqueId("audio_link");
    const emu = (pts: number) => pts * 12700;
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [
          {
            createShape: {
              objectId: boxId,
              shapeType: "TEXT_BOX",
              elementProperties: {
                pageObjectId: slideObjectId,
                size: { width: { magnitude: emu(200), unit: "EMU" }, height: { magnitude: emu(30), unit: "EMU" } },
                transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: "EMU" },
              },
            },
          },
          { insertText: { objectId: boxId, text: linkText, insertionIndex: 0 } },
          {
            updateTextStyle: {
              objectId: boxId,
              style: { link: { url: audioUrl } },
              textRange: { type: "ALL" },
              fields: "link",
            },
          },
        ],
      },
    });
    return textResult({ objectId: boxId });
  });

  server.tool("slides_update_text_style", "Update text styling on a slide element", {
    presentationId: z.string(),
    objectId: z.string().describe("ID of the shape/text box"),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    fontSize: z.number().optional().describe("Font size in points"),
    fontFamily: z.string().optional(),
    foregroundColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional(),
  }, async ({ presentationId, objectId, bold, italic, underline, fontSize, fontFamily, foregroundColor }) => {
    const style: Record<string, unknown> = {};
    const fields: string[] = [];
    if (bold !== undefined) { style.bold = bold; fields.push("bold"); }
    if (italic !== undefined) { style.italic = italic; fields.push("italic"); }
    if (underline !== undefined) { style.underline = underline; fields.push("underline"); }
    if (fontSize) { style.fontSize = { magnitude: fontSize, unit: "PT" }; fields.push("fontSize"); }
    if (fontFamily) { style.fontFamily = fontFamily; fields.push("fontFamily"); }
    if (foregroundColor) { style.foregroundColor = { opaqueColor: { rgbColor: foregroundColor } }; fields.push("foregroundColor"); }

    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{
          updateTextStyle: { objectId, style, textRange: { type: "ALL" }, fields: fields.join(",") },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("slides_update_paragraph_style", "Update paragraph styling on a slide element", {
    presentationId: z.string(),
    objectId: z.string(),
    alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional(),
    lineSpacing: z.number().optional().describe("Line spacing percentage (100 = single)"),
    spaceAbove: z.number().optional().describe("Space above in points"),
    spaceBelow: z.number().optional().describe("Space below in points"),
  }, async ({ presentationId, objectId, alignment, lineSpacing, spaceAbove, spaceBelow }) => {
    const style: Record<string, unknown> = {};
    const fields: string[] = [];
    if (alignment) { style.alignment = alignment; fields.push("alignment"); }
    if (lineSpacing) { style.lineSpacing = lineSpacing; fields.push("lineSpacing"); }
    if (spaceAbove !== undefined) { style.spaceAbove = { magnitude: spaceAbove, unit: "PT" }; fields.push("spaceAbove"); }
    if (spaceBelow !== undefined) { style.spaceBelow = { magnitude: spaceBelow, unit: "PT" }; fields.push("spaceBelow"); }

    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{
          updateParagraphStyle: { objectId, style, textRange: { type: "ALL" }, fields: fields.join(",") },
        }],
      },
    });
    return textResult({ success: true });
  });

  server.tool("slides_export_as_pdf", "Export entire presentation as PDF", {
    presentationId: z.string(),
    outputPath: z.string().optional().describe("Local path to save the PDF. If omitted, writes to a temp file and returns its path."),
  }, async ({ presentationId, outputPath }) => {
    const res = await driveApi.files.export(
      { fileId: presentationId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    const bytes = Buffer.from(res.data as ArrayBuffer);
    const path = outputPath || tempPdfPath(`slides-${presentationId}`);
    await writeFile(path, bytes);
    return textResult({ success: true, path, bytes: bytes.byteLength });
  });

  server.tool("slides_export_slide_as_pdf", "Export a single slide as a standalone one-page PDF", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    outputPath: z.string().optional().describe("Local path to save the single-page PDF. If omitted, writes to a temp file and returns its path."),
  }, async ({ presentationId, slideObjectId, outputPath }) => {
    const pres = await api.presentations.get({ presentationId, fields: "slides.objectId" });
    const slideIndex = pres.data.slides?.findIndex((s) => s.objectId === slideObjectId);
    if (slideIndex === undefined || slideIndex < 0) return textResult({ error: "Slide not found" });

    const res = await driveApi.files.export(
      { fileId: presentationId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    const fullBytes = new Uint8Array(res.data as ArrayBuffer);
    const srcDoc = await PDFDocument.load(fullBytes);
    if (slideIndex >= srcDoc.getPageCount()) {
      return textResult({ error: `Slide index ${slideIndex} out of range for the exported PDF (${srcDoc.getPageCount()} pages)` });
    }

    const outDoc = await PDFDocument.create();
    const [copiedPage] = await outDoc.copyPages(srcDoc, [slideIndex]);
    outDoc.addPage(copiedPage);
    const outBytes = await outDoc.save();

    const path = outputPath || tempPdfPath(`slide-${presentationId}-${slideIndex}`);
    await writeFile(path, outBytes);
    return textResult({ success: true, path, slideIndex, bytes: outBytes.byteLength });
  });

  server.tool("slides_get_thumbnail", "Render a slide to a PNG image and return it inline, so you can SEE the slide and iterate on its design (the see-and-check loop). Defaults to the first slide and MEDIUM size. Use this after styling/layout changes to verify the result visually.", {
    presentationId: z.string(),
    slideObjectId: z.string().optional().describe("Specific slide to render (defaults to first slide)"),
    thumbnailSize: z.enum(["LARGE", "MEDIUM", "SMALL"]).optional().default("MEDIUM").describe("Rendered image size. MEDIUM is a good default; LARGE for fine detail."),
  }, async ({ presentationId, slideObjectId, thumbnailSize }) => {
    const pres = await api.presentations.get({ presentationId, fields: "slides(objectId)" });
    const targetSlide = slideObjectId
      ? pres.data.slides?.find((s) => s.objectId === slideObjectId)
      : pres.data.slides?.[0];

    if (!targetSlide) return textResult({ error: "Slide not found" });

    const thumb = await api.presentations.pages.getThumbnail({
      presentationId,
      pageObjectId: targetSlide.objectId!,
      "thumbnailProperties.thumbnailSize": thumbnailSize,
      "thumbnailProperties.mimeType": "PNG",
    });
    const contentUrl = thumb.data.contentUrl;
    if (!contentUrl) return textResult({ error: "No thumbnail contentUrl returned" });

    // The contentUrl is a short-lived (~30 min) googleusercontent link; fetch
    // the bytes with plain fetch and return them as an MCP image block so the
    // model can view the slide directly.
    const imgRes = await fetch(contentUrl);
    if (!imgRes.ok) {
      return textResult({ error: `Failed to fetch thumbnail image (HTTP ${imgRes.status})`, contentUrl });
    }
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    // Guard against returning an oversized payload inline. MEDIUM/SMALL are
    // tiny; only an unexpectedly large LARGE render would trip this.
    const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return textResult({
        note: `Thumbnail is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte inline cap. Use a smaller thumbnailSize, or open the URL.`,
        contentUrl,
        width: thumb.data.width,
        height: thumb.data.height,
      });
    }
    return {
      content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }],
    };
  });

  server.tool("slides_list_layouts", "List the theme LAYOUTS and MASTERS available in a presentation (id, displayName, and the placeholder types each provides). Call this first to pick a real layoutId for slides_add_slide so new slides match the deck's theme, instead of building slides from blank + floating boxes.", {
    presentationId: z.string(),
  }, async ({ presentationId }) => {
    const pres = await api.presentations.get({
      presentationId,
      fields: "layouts(objectId,layoutProperties(name,displayName,masterObjectId),pageElements(objectId,shape(placeholder(type,index)))),masters(objectId,masterProperties(displayName),pageElements(objectId,shape(placeholder(type,index))))",
    });
    const layouts = (pres.data.layouts ?? []).map((l) => ({
      objectId: l.objectId,
      name: l.layoutProperties?.name,
      displayName: l.layoutProperties?.displayName,
      masterObjectId: l.layoutProperties?.masterObjectId,
      placeholders: placeholderMap(l),
    }));
    const masters = (pres.data.masters ?? []).map((m) => ({
      objectId: m.objectId,
      displayName: m.masterProperties?.displayName,
      placeholders: placeholderMap(m),
    }));
    return textResult({ layouts, masters });
  });

  server.tool("slides_fill_placeholder", "Set the text of an existing placeholder or shape. Two modes: (1) pass objectId to replace ALL text in that specific shape (use with placeholder IDs from slides_add_slide) — clears existing text then inserts; (2) pass findText to replaceAllText across the whole deck (or the given pageObjectIds). Use mode 1 for filling a slide's title/body placeholders; mode 2 for template-style find/replace.", {
    presentationId: z.string(),
    objectId: z.string().optional().describe("Target a specific placeholder/shape by object ID (replaces all its text)."),
    findText: z.string().optional().describe("Deck-wide replace: find this text and swap it for `text`. Mutually exclusive with objectId."),
    text: z.string().describe("The replacement text."),
    matchCase: z.boolean().optional().default(false).describe("For findText mode: case-sensitive match."),
    pageObjectIds: z.array(z.string()).optional().describe("For findText mode: limit replacement to these slide/page IDs."),
  }, async ({ presentationId, objectId, findText, text, matchCase, pageObjectIds }) => {
    if ((objectId && findText) || (!objectId && !findText)) {
      return textResult({ error: "Provide exactly one of objectId (fill a specific shape) or findText (deck-wide replace)." });
    }

    if (findText) {
      const res = await api.presentations.batchUpdate({
        presentationId,
        requestBody: {
          requests: [{
            replaceAllText: {
              containsText: { text: findText, matchCase },
              replaceText: text,
              pageObjectIds: pageObjectIds,
            },
          }],
        },
      });
      const changed = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
      return textResult({ success: true, occurrencesChanged: changed });
    }

    // objectId mode: clear existing text (only if there is any — deleteText on
    // an empty shape errors) then insert the new text.
    const pres = await api.presentations.get({
      presentationId,
      fields: "slides(pageElements(objectId,shape(text(textElements(textRun(content))))))",
    });
    let existingLen = 0;
    for (const s of pres.data.slides ?? []) {
      const pe = s.pageElements?.find((e) => e.objectId === objectId);
      if (pe) { existingLen = textContentLength(pe.shape?.text); break; }
    }
    const requests: slides_v1.Schema$Request[] = [];
    if (existingLen > 0) requests.push({ deleteText: { objectId: objectId!, textRange: { type: "ALL" } } });
    requests.push({ insertText: { objectId: objectId!, text, insertionIndex: 0 } });
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ success: true, objectId });
  });

  server.tool("slides_batch_update", "Escape hatch: send raw Google Slides API requests to presentations.batchUpdate. Pass `requests` as a JSON array of request objects (max 50). Use this for capabilities the dedicated tools don't cover — e.g. createLine, groupObjects, updateTableCellProperties, updateImageProperties, mergeTableCells, updatePageElementsZOrder, deleteTableRow. Each entry is one request keyed by type, e.g. {\"insertText\":{\"objectId\":\"x\",\"text\":\"hi\",\"insertionIndex\":0}}.", {
    presentationId: z.string(),
    requests: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).describe("A JSON array (or JSON string) of Slides API request objects."),
  }, async ({ presentationId, requests }) => {
    const parsed = parseBatchRequests(requests, 50) as slides_v1.Schema$Request[];
    const res = await api.presentations.batchUpdate({ presentationId, requestBody: { requests: parsed } });
    return textResult({ success: true, applied: parsed.length, replies: res.data.replies });
  });

  server.tool("slides_create_from_template", "Copy a template presentation and fill it in. Duplicates the deck via Drive, then applies `replacements` (find text -> replacement text) and optional `imageReplacements` (find text -> image URL, swaps the matching shape for the image) across the copy. Returns the new presentation ID/URL. Ideal for branded/repeatable decks.", {
    templatePresentationId: z.string().describe("Presentation to copy as the template."),
    title: z.string().describe("Title for the new copy."),
    parentFolderId: z.string().optional().describe("Drive folder to place the copy in."),
    replacements: z.record(z.string(), z.string()).optional().describe("Map of placeholder text -> replacement text, e.g. {\"{{client}}\":\"Acme\"}."),
    imageReplacements: z.record(z.string(), z.string()).optional().describe("Map of placeholder text -> image URL; the shape containing the text is replaced with the image."),
    matchCase: z.boolean().optional().default(false),
  }, async ({ templatePresentationId, title, parentFolderId, replacements, imageReplacements, matchCase }) => {
    const copy = await driveApi.files.copy({
      fileId: templatePresentationId,
      requestBody: { name: title, parents: parentFolderId ? [parentFolderId] : undefined },
      fields: "id,name",
    });
    const newId = copy.data.id!;
    const requests = buildTemplateReplacementRequests(replacements, imageReplacements, matchCase);
    let replaced;
    if (requests.length) {
      const res = await api.presentations.batchUpdate({ presentationId: newId, requestBody: { requests } });
      replaced = res.data.replies
        ?.map((r) => r.replaceAllText?.occurrencesChanged ?? r.replaceAllShapesWithImage?.occurrencesChanged)
        .filter((n) => n !== undefined);
    }
    return textResult({
      presentationId: newId,
      title: copy.data.name,
      url: `https://docs.google.com/presentation/d/${newId}/edit`,
      replacementsApplied: requests.length,
      occurrencesChanged: replaced,
    });
  });

  server.tool("slides_style_shape", "Style a shape or text box: solid fill color, outline color/weight, drop shadow on/off, and text autofit. Colors are RGB fractions 0..1. Use after slides_add_shape/slides_add_text to make elements look designed. For placeholders, note their theme styling may already look good — style sparingly.", {
    presentationId: z.string(),
    objectId: z.string().describe("Shape/text box object ID"),
    fillColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe("Solid background fill, RGB 0..1"),
    fillAlpha: z.number().optional().describe("Fill opacity 0..1 (1 = opaque)"),
    outlineColor: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe("Outline (border) color, RGB 0..1"),
    outlineWeight: z.number().optional().describe("Outline thickness in points"),
    shadow: z.boolean().optional().describe("Turn the drop shadow on (true) or off (false)"),
    autofit: z.enum(["NONE", "SHAPE_AUTOFIT", "TEXT_AUTOFIT"]).optional().describe("Text autofit mode. TEXT_AUTOFIT shrinks text to fit the box."),
  }, async ({ presentationId, objectId, fillColor, fillAlpha, outlineColor, outlineWeight, shadow, autofit }) => {
    const request = buildStyleShapeRequest(objectId, {
      fillColor,
      fillAlpha,
      outlineColor,
      outlineWeightPt: outlineWeight,
      shadow,
      autofitType: autofit,
    });
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests: [request] } });
    return textResult({ success: true, objectId });
  });

  server.tool("slides_set_background", "Set a slide's background to a solid color or a stretched image. Target one slide (slideObjectId) or every slide (allSlides: true). Use a subtle solid color or a full-bleed image to establish visual identity.", {
    presentationId: z.string(),
    slideObjectId: z.string().optional().describe("Slide to set (omit and pass allSlides for the whole deck)"),
    allSlides: z.boolean().optional().default(false).describe("Apply to every slide in the deck"),
    color: z.object({ red: z.number(), green: z.number(), blue: z.number() }).optional().describe("Solid background color, RGB 0..1"),
    imageUrl: z.string().optional().describe("Public image URL to stretch as the background (mutually exclusive with color)"),
  }, async ({ presentationId, slideObjectId, allSlides, color, imageUrl }) => {
    if ((color && imageUrl) || (!color && !imageUrl)) {
      return textResult({ error: "Provide exactly one of color or imageUrl." });
    }
    if (!slideObjectId && !allSlides) {
      return textResult({ error: "Provide slideObjectId or set allSlides: true." });
    }
    let slideIds: string[];
    if (allSlides) {
      const pres = await api.presentations.get({ presentationId, fields: "slides(objectId)" });
      slideIds = (pres.data.slides ?? []).map((s) => s.objectId!).filter(Boolean);
    } else {
      slideIds = [slideObjectId!];
    }
    const fill: BackgroundFill = imageUrl ? { imageUrl } : { solidColor: color! };
    const requests = buildSetBackgroundRequests(slideIds, fill);
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ success: true, slidesUpdated: slideIds.length });
  });

  server.tool("slides_add_table", "Add a table to a slide, optionally pre-filled with data. Provide `data` as a 2D array of cell strings; rows/columns are inferred from it (or pass rows/columns for an empty table). Good for comparisons, schedules, and structured content.", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    rows: z.number().optional().describe("Row count (inferred from data if omitted)"),
    columns: z.number().optional().describe("Column count (inferred from data if omitted)"),
    data: z.array(z.array(z.string())).optional().describe("2D array of cell text to pre-fill"),
    x: z.number().optional().default(50).describe("X position in points"),
    y: z.number().optional().default(50).describe("Y position in points"),
    width: z.number().optional().default(400).describe("Width in points"),
    height: z.number().optional().default(200).describe("Height in points"),
  }, async ({ presentationId, slideObjectId, rows, columns, data, x, y, width, height }) => {
    const numRows = rows ?? data?.length ?? 1;
    const numCols = columns ?? data?.[0]?.length ?? 1;
    const tableId = uniqueId("table");
    const requests: slides_v1.Schema$Request[] = [{
      createTable: {
        objectId: tableId,
        rows: numRows,
        columns: numCols,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: { width: { magnitude: ptToEmu(width), unit: "EMU" }, height: { magnitude: ptToEmu(height), unit: "EMU" } },
          transform: { scaleX: 1, scaleY: 1, translateX: ptToEmu(x), translateY: ptToEmu(y), unit: "EMU" },
        },
      },
    }];
    // Cells can be filled in the same batch: createTable runs before the
    // insertText requests that reference the new table.
    if (data) {
      for (let r = 0; r < data.length; r++) {
        for (let c = 0; c < data[r].length; c++) {
          const cellText = data[r][c];
          if (cellText) {
            requests.push({
              insertText: { objectId: tableId, cellLocation: { rowIndex: r, columnIndex: c }, text: cellText, insertionIndex: 0 },
            });
          }
        }
      }
    }
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ tableId, rows: numRows, columns: numCols });
  });

  server.tool("slides_set_table_cell_text", "Set the text of one cell in an existing table (by table object ID and 0-based row/column). Clears the cell first by default so this is a true 'set'.", {
    presentationId: z.string(),
    tableObjectId: z.string(),
    rowIndex: z.number().describe("0-based row"),
    columnIndex: z.number().describe("0-based column"),
    text: z.string(),
    clearFirst: z.boolean().optional().default(true).describe("Delete existing cell text before inserting"),
  }, async ({ presentationId, tableObjectId, rowIndex, columnIndex, text, clearFirst }) => {
    const requests: slides_v1.Schema$Request[] = [];
    if (clearFirst) {
      // Only clear if the cell actually has text — deleteText on an empty cell errors.
      const pres = await api.presentations.get({
        presentationId,
        fields: "slides(pageElements(objectId,table(tableRows(tableCells(text(textElements(textRun(content))))))))",
      });
      let hasText = false;
      for (const s of pres.data.slides ?? []) {
        const pe = s.pageElements?.find((e) => e.objectId === tableObjectId);
        const cell = pe?.table?.tableRows?.[rowIndex]?.tableCells?.[columnIndex];
        if (cell) { hasText = textContentLength(cell.text) > 0; break; }
      }
      if (hasText) {
        requests.push({ deleteText: { objectId: tableObjectId, cellLocation: { rowIndex, columnIndex }, textRange: { type: "ALL" } } });
      }
    }
    requests.push({ insertText: { objectId: tableObjectId, cellLocation: { rowIndex, columnIndex }, text, insertionIndex: 0 } });
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ success: true });
  });

  server.tool("slides_add_sheets_chart", "Embed a chart from a Google Sheets spreadsheet onto a slide. LINKED keeps it updatable from the source sheet (refreshable); NOT_LINKED_IMAGE pastes a static image snapshot. Get spreadsheetId and chartId from the Sheets tools.", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    spreadsheetId: z.string().describe("Source spreadsheet ID"),
    chartId: z.number().describe("Chart ID within the spreadsheet"),
    linkingMode: z.enum(["LINKED", "NOT_LINKED_IMAGE"]).optional().default("LINKED"),
    x: z.number().optional().default(50).describe("X position in points"),
    y: z.number().optional().default(50).describe("Y position in points"),
    width: z.number().optional().default(400).describe("Width in points"),
    height: z.number().optional().default(300).describe("Height in points"),
  }, async ({ presentationId, slideObjectId, spreadsheetId, chartId, linkingMode, x, y, width, height }) => {
    const chartObjectId = uniqueId("chart");
    await api.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{
          createSheetsChart: {
            objectId: chartObjectId,
            spreadsheetId,
            chartId,
            linkingMode,
            elementProperties: {
              pageObjectId: slideObjectId,
              size: { width: { magnitude: ptToEmu(width), unit: "EMU" }, height: { magnitude: ptToEmu(height), unit: "EMU" } },
              transform: { scaleX: 1, scaleY: 1, translateX: ptToEmu(x), translateY: ptToEmu(y), unit: "EMU" },
            },
          },
        }],
      },
    });
    return textResult({ chartObjectId, linkingMode });
  });

  server.tool("slides_set_speaker_notes", "Set the speaker notes for a slide. Resolves the slide's notes page speaker-notes shape and replaces its text (clearing existing notes first by default).", {
    presentationId: z.string(),
    slideObjectId: z.string(),
    notes: z.string(),
    clearFirst: z.boolean().optional().default(true),
  }, async ({ presentationId, slideObjectId, notes, clearFirst }) => {
    const pres = await api.presentations.get({
      presentationId,
      fields: "slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId),pageElements(objectId,shape(text(textElements(textRun(content))))))))",
    });
    const slide = pres.data.slides?.find((s) => s.objectId === slideObjectId);
    if (!slide) return textResult({ error: "Slide not found" });
    const notesPage = slide.slideProperties?.notesPage;
    const notesId = notesPage?.notesProperties?.speakerNotesObjectId;
    if (!notesId) return textResult({ error: "Could not resolve the speaker notes shape for this slide." });

    const notesEl = notesPage?.pageElements?.find((e) => e.objectId === notesId);
    const existingLen = textContentLength(notesEl?.shape?.text);

    const requests: slides_v1.Schema$Request[] = [];
    if (clearFirst && existingLen > 0) requests.push({ deleteText: { objectId: notesId, textRange: { type: "ALL" } } });
    requests.push({ insertText: { objectId: notesId, text: notes, insertionIndex: 0 } });
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ success: true, speakerNotesObjectId: notesId });
  });

  server.tool("slides_align_elements", "Align or evenly distribute page elements on a slide (the Slides editor has these buttons; the API does not, so positions are computed here from current geometry). alignment aligns edges/centers to the selection's bounding box; distribute spreads 3+ elements with equal gaps. Pass 2+ element IDs (3+ for distribute).", {
    presentationId: z.string(),
    objectIds: z.array(z.string()).describe("Element object IDs to align/distribute (on the same slide)"),
    mode: z.enum(["left", "center", "right", "top", "middle", "bottom", "distribute_horizontal", "distribute_vertical"]).describe("left/center/right = horizontal align; top/middle/bottom = vertical align; distribute_* = equal spacing"),
  }, async ({ presentationId, objectIds, mode }) => {
    const pres = await api.presentations.get({
      presentationId,
      fields: "slides(pageElements(objectId,size(width(magnitude),height(magnitude)),transform))",
    });
    const byId = new Map<string, slides_v1.Schema$PageElement>();
    for (const s of pres.data.slides ?? []) {
      for (const pe of s.pageElements ?? []) {
        if (pe.objectId) byId.set(pe.objectId, pe);
      }
    }
    const elements: AlignInputElement[] = [];
    const missing: string[] = [];
    for (const id of objectIds) {
      const pe = byId.get(id);
      const w = pe?.size?.width?.magnitude;
      const h = pe?.size?.height?.magnitude;
      if (!pe || w == null || h == null || !pe.transform) { missing.push(id); continue; }
      elements.push({ objectId: id, transform: pe.transform, width: w, height: h });
    }
    if (missing.length) return textResult({ error: `Elements not found or missing size/transform: ${missing.join(", ")}` });

    const aligned = computeAlignedTransforms(elements, mode);
    if (aligned.length === 0) {
      return textResult({ success: true, updated: 0, note: mode.startsWith("distribute") ? "Distribute needs at least 3 elements." : "Alignment needs at least 2 elements." });
    }
    const requests: slides_v1.Schema$Request[] = aligned.map((a) => ({
      updatePageElementTransform: { objectId: a.objectId, applyMode: "ABSOLUTE", transform: a.transform },
    }));
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ success: true, updated: aligned.length, mode });
  });

  server.tool("slides_edit_text", "Low-level text editing on an existing shape/text box by object ID: insert text at an index, delete a text range, or replace a range. Use slides_fill_placeholder to set a placeholder's whole text; use this for surgical edits to non-placeholder shapes (append a line, delete a span, splice text).", {
    presentationId: z.string(),
    objectId: z.string().describe("Shape/text box object ID"),
    operation: z.enum(["insert", "delete", "replace"]).describe("insert text at insertionIndex; delete [startIndex,endIndex); replace = delete then insert at startIndex"),
    text: z.string().optional().describe("Text to insert (required for insert/replace)"),
    insertionIndex: z.number().optional().default(0).describe("For insert: 0-based index to insert at"),
    startIndex: z.number().optional().describe("For delete/replace: range start (0-based)"),
    endIndex: z.number().optional().describe("For delete/replace: range end (exclusive)"),
  }, async ({ presentationId, objectId, operation, text, insertionIndex, startIndex, endIndex }) => {
    const requests: slides_v1.Schema$Request[] = [];
    if (operation === "insert") {
      if (text === undefined) return textResult({ error: "insert requires `text`." });
      requests.push({ insertText: { objectId, text, insertionIndex } });
    } else if (operation === "delete") {
      if (startIndex === undefined || endIndex === undefined) return textResult({ error: "delete requires startIndex and endIndex." });
      requests.push({ deleteText: { objectId, textRange: { type: "FIXED_RANGE", startIndex, endIndex } } });
    } else {
      if (text === undefined || startIndex === undefined || endIndex === undefined) return textResult({ error: "replace requires text, startIndex, and endIndex." });
      requests.push({ deleteText: { objectId, textRange: { type: "FIXED_RANGE", startIndex, endIndex } } });
      requests.push({ insertText: { objectId, text, insertionIndex: startIndex } });
    }
    await api.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return textResult({ success: true, operation });
  });
}
