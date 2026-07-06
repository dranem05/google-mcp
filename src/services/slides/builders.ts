import { slides_v1 } from "googleapis";

/** Points -> English Metric Units (1 pt = 12700 EMU), the unit the Slides API uses. */
export function ptToEmu(pt: number): number {
  return pt * 12700;
}

export interface RgbColor {
  red?: number;
  green?: number;
  blue?: number;
}

// ---------------------------------------------------------------------------
// Item 5: createSlide with a predefined layout + placeholder ID mappings.
// ---------------------------------------------------------------------------

export interface PlaceholderSpec {
  /** Placeholder type on the layout, e.g. TITLE, BODY, SUBTITLE, CENTERED_TITLE. */
  type: string;
  /** Placeholder index (multiple placeholders of the same type are distinguished by index). Defaults to 0. */
  index?: number;
  /** The object ID to assign to the placeholder created on the new slide. */
  objectId: string;
}

export interface CreateSlideOptions {
  slideObjectId?: string;
  predefinedLayout?: string;
  layoutId?: string;
  insertionIndex?: number;
  placeholders?: PlaceholderSpec[];
}

/**
 * Builds a single `createSlide` batchUpdate request. When a layout reference
 * (predefinedLayout or layoutId) and placeholder specs are supplied, emits
 * `placeholderIdMappings` so the created placeholders get caller-chosen object
 * IDs — letting the caller immediately fill them by ID without a round-trip to
 * discover them. `placeholderIdMappings` may only be used alongside a layout
 * reference, so they are dropped when no layout is specified.
 */
export function buildCreateSlideRequest(opts: CreateSlideOptions): slides_v1.Schema$Request {
  const createSlide: slides_v1.Schema$CreateSlideRequest = {};
  if (opts.slideObjectId) createSlide.objectId = opts.slideObjectId;
  if (opts.insertionIndex !== undefined) createSlide.insertionIndex = opts.insertionIndex;

  let hasLayoutRef = false;
  if (opts.predefinedLayout) {
    createSlide.slideLayoutReference = { predefinedLayout: opts.predefinedLayout };
    hasLayoutRef = true;
  } else if (opts.layoutId) {
    createSlide.slideLayoutReference = { layoutId: opts.layoutId };
    hasLayoutRef = true;
  }

  if (hasLayoutRef && opts.placeholders?.length) {
    createSlide.placeholderIdMappings = opts.placeholders.map((p) => ({
      layoutPlaceholder: { type: p.type, index: p.index ?? 0 },
      objectId: p.objectId,
    }));
  }

  return { createSlide };
}

// ---------------------------------------------------------------------------
// Item 9: raw batchUpdate passthrough — validate + size-guard, never whitelist.
// ---------------------------------------------------------------------------

/**
 * Validates a caller-supplied `requests` payload for slides_batch_update. The
 * payload may arrive either as a JSON string (models often stringify) or an
 * already-parsed array. Enforces: valid JSON, is an array, is non-empty, is
 * within `max` entries, and every entry is a plain object. Deliberately does
 * NOT inspect request types — passthrough is the whole point.
 */
export function parseBatchRequests(input: unknown, max = 50): Record<string, unknown>[] {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("`requests` must be a JSON array of request objects; the string provided was not valid JSON.");
    }
  }
  if (!Array.isArray(value)) {
    throw new Error("`requests` must be an array of request objects.");
  }
  if (value.length === 0) {
    throw new Error("`requests` is empty; provide at least one request object.");
  }
  if (value.length > max) {
    throw new Error(`Too many requests: ${value.length} > ${max}. Split into multiple slides_batch_update calls.`);
  }
  value.forEach((r, i) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new Error(`requests[${i}] must be an object (e.g. { "insertText": { ... } }).`);
    }
  });
  return value as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Item 10: template replacement requests (replaceAllText + image swaps).
// ---------------------------------------------------------------------------

/**
 * Builds replaceAllText / replaceAllShapesWithImage requests for
 * slides_create_from_template. `replacements` maps found-text -> replacement
 * text; `imageReplacements` maps found-text -> image URL (the shape containing
 * the text is swapped for the image).
 */
export function buildTemplateReplacementRequests(
  replacements: Record<string, string> | undefined,
  imageReplacements: Record<string, string> | undefined,
  matchCase = false
): slides_v1.Schema$Request[] {
  const requests: slides_v1.Schema$Request[] = [];
  for (const [find, replace] of Object.entries(replacements ?? {})) {
    requests.push({
      replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace },
    });
  }
  for (const [find, imageUrl] of Object.entries(imageReplacements ?? {})) {
    requests.push({
      replaceAllShapesWithImage: { containsText: { text: find, matchCase }, imageUrl },
    });
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Item 11: updateShapeProperties (fill / outline / shadow / autofit).
// ---------------------------------------------------------------------------

export interface StyleShapeOptions {
  fillColor?: RgbColor;
  fillAlpha?: number;
  outlineColor?: RgbColor;
  outlineWeightPt?: number;
  shadow?: boolean;
  autofitType?: string;
}

/**
 * Builds a single `updateShapeProperties` request with a precise field mask.
 * Only the properties the caller set are included; throws if nothing was set
 * (the API requires a non-empty mask).
 */
export function buildStyleShapeRequest(objectId: string, opts: StyleShapeOptions): slides_v1.Schema$Request {
  const shapeProperties: slides_v1.Schema$ShapeProperties = {};
  const fields: string[] = [];

  if (opts.fillColor) {
    shapeProperties.shapeBackgroundFill = {
      solidFill: { color: { rgbColor: opts.fillColor } },
    };
    fields.push("shapeBackgroundFill.solidFill.color");
    if (opts.fillAlpha !== undefined) {
      shapeProperties.shapeBackgroundFill.solidFill!.alpha = opts.fillAlpha;
      fields.push("shapeBackgroundFill.solidFill.alpha");
    }
  }

  if (opts.outlineColor || opts.outlineWeightPt !== undefined) {
    shapeProperties.outline = {};
    if (opts.outlineColor) {
      shapeProperties.outline.outlineFill = { solidFill: { color: { rgbColor: opts.outlineColor } } };
      fields.push("outline.outlineFill.solidFill.color");
    }
    if (opts.outlineWeightPt !== undefined) {
      shapeProperties.outline.weight = { magnitude: ptToEmu(opts.outlineWeightPt), unit: "EMU" };
      fields.push("outline.weight");
    }
  }

  if (opts.shadow !== undefined) {
    shapeProperties.shadow = { propertyState: opts.shadow ? "RENDERED" : "NOT_RENDERED" };
    fields.push("shadow.propertyState");
  }

  if (opts.autofitType) {
    shapeProperties.autofit = { autofitType: opts.autofitType };
    fields.push("autofit.autofitType");
  }

  if (fields.length === 0) {
    throw new Error("slides_style_shape: nothing to update — set at least one of fillColor, outlineColor, outlineWeight, shadow, autofit.");
  }

  return { updateShapeProperties: { objectId, shapeProperties, fields: fields.join(",") } };
}

// ---------------------------------------------------------------------------
// Item 12: updatePageProperties (solid color or stretched picture background).
// ---------------------------------------------------------------------------

export type BackgroundFill = { solidColor: RgbColor; alpha?: number } | { imageUrl: string };

/** Builds one updatePageProperties request per target slide for a background fill. */
export function buildSetBackgroundRequests(slideIds: string[], fill: BackgroundFill): slides_v1.Schema$Request[] {
  return slideIds.map((slideId) => {
    if ("imageUrl" in fill) {
      return {
        updatePageProperties: {
          objectId: slideId,
          pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: fill.imageUrl } } },
          fields: "pageBackgroundFill.stretchedPictureFill.contentUrl",
        },
      };
    }
    const solidFill: slides_v1.Schema$SolidFill = { color: { rgbColor: fill.solidColor } };
    const fields = ["pageBackgroundFill.solidFill.color"];
    if (fill.alpha !== undefined) {
      solidFill.alpha = fill.alpha;
      fields.push("pageBackgroundFill.solidFill.alpha");
    }
    return {
      updatePageProperties: {
        objectId: slideId,
        pageProperties: { pageBackgroundFill: { solidFill } },
        fields: fields.join(","),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Item 16: align / distribute transform math (no native API — computed here).
// ---------------------------------------------------------------------------

export type AlignMode =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "distribute_horizontal"
  | "distribute_vertical";

export interface AlignInputElement {
  objectId: string;
  /** The element's current transform (translate is the top-left position). */
  transform: slides_v1.Schema$AffineTransform;
  /** Pre-scale width magnitude, in EMU. */
  width: number;
  /** Pre-scale height magnitude, in EMU. */
  height: number;
}

export interface AlignedTransform {
  objectId: string;
  transform: slides_v1.Schema$AffineTransform;
}

interface Box {
  el: AlignInputElement;
  left: number;
  top: number;
  renderedWidth: number;
  renderedHeight: number;
}

function toBox(el: AlignInputElement): Box {
  const scaleX = el.transform.scaleX ?? 1;
  const scaleY = el.transform.scaleY ?? 1;
  return {
    el,
    left: el.transform.translateX ?? 0,
    top: el.transform.translateY ?? 0,
    renderedWidth: el.width * scaleX,
    renderedHeight: el.height * scaleY,
  };
}

/** Clones a transform, overriding translateX and/or translateY, preserving scale/shear/unit. */
function withTranslate(
  t: slides_v1.Schema$AffineTransform,
  next: { translateX?: number; translateY?: number }
): slides_v1.Schema$AffineTransform {
  return {
    scaleX: t.scaleX ?? 1,
    scaleY: t.scaleY ?? 1,
    shearX: t.shearX ?? 0,
    shearY: t.shearY ?? 0,
    translateX: next.translateX ?? t.translateX ?? 0,
    translateY: next.translateY ?? t.translateY ?? 0,
    unit: t.unit ?? "EMU",
  };
}

/**
 * Computes new transforms to align or distribute a set of page elements,
 * relative to the bounding box of the selection (matching the behavior of the
 * align/distribute buttons in the Slides editor). Only the affected axis is
 * changed; the other axis, scale, and shear are preserved. Distribute needs at
 * least 3 elements; alignment needs at least 2. Returns [] when there is
 * nothing meaningful to do.
 */
export function computeAlignedTransforms(elements: AlignInputElement[], mode: AlignMode): AlignedTransform[] {
  const isDistribute = mode === "distribute_horizontal" || mode === "distribute_vertical";
  if (isDistribute ? elements.length < 3 : elements.length < 2) return [];

  const boxes = elements.map(toBox);
  const minLeft = Math.min(...boxes.map((b) => b.left));
  const maxRight = Math.max(...boxes.map((b) => b.left + b.renderedWidth));
  const minTop = Math.min(...boxes.map((b) => b.top));
  const maxBottom = Math.max(...boxes.map((b) => b.top + b.renderedHeight));

  if (mode === "distribute_horizontal") {
    const sorted = [...boxes].sort((a, b) => a.left - b.left);
    const totalWidth = sorted.reduce((s, b) => s + b.renderedWidth, 0);
    const gap = (maxRight - minLeft - totalWidth) / (sorted.length - 1);
    let cursor = minLeft;
    const out: AlignedTransform[] = [];
    for (const b of sorted) {
      out.push({ objectId: b.el.objectId, transform: withTranslate(b.el.transform, { translateX: cursor }) });
      cursor += b.renderedWidth + gap;
    }
    return out;
  }

  if (mode === "distribute_vertical") {
    const sorted = [...boxes].sort((a, b) => a.top - b.top);
    const totalHeight = sorted.reduce((s, b) => s + b.renderedHeight, 0);
    const gap = (maxBottom - minTop - totalHeight) / (sorted.length - 1);
    let cursor = minTop;
    const out: AlignedTransform[] = [];
    for (const b of sorted) {
      out.push({ objectId: b.el.objectId, transform: withTranslate(b.el.transform, { translateY: cursor }) });
      cursor += b.renderedHeight + gap;
    }
    return out;
  }

  return boxes.map((b) => {
    let translateX: number | undefined;
    let translateY: number | undefined;
    switch (mode) {
      case "left":
        translateX = minLeft;
        break;
      case "right":
        translateX = maxRight - b.renderedWidth;
        break;
      case "center":
        translateX = (minLeft + maxRight) / 2 - b.renderedWidth / 2;
        break;
      case "top":
        translateY = minTop;
        break;
      case "bottom":
        translateY = maxBottom - b.renderedHeight;
        break;
      case "middle":
        translateY = (minTop + maxBottom) / 2 - b.renderedHeight / 2;
        break;
    }
    return { objectId: b.el.objectId, transform: withTranslate(b.el.transform, { translateX, translateY }) };
  });
}

// ---------------------------------------------------------------------------
// Shared helper for items 13/15: how much real text a shape/cell holds.
// ---------------------------------------------------------------------------

/**
 * Total length of the actual text runs in a shape/cell's text content,
 * ignoring the implicit trailing newline (which has no textRun). Used to decide
 * whether a deleteText(ALL) is needed before inserting replacement text —
 * deleting from an empty shape/cell errors, so we only clear when length > 0.
 */
export function textContentLength(text: slides_v1.Schema$TextContent | undefined): number {
  let len = 0;
  for (const te of text?.textElements ?? []) {
    if (te.textRun?.content) len += te.textRun.content.length;
  }
  return len;
}
