import { gmail_v1 } from "googleapis";
import {
  buildRawEmail,
  decodeBase64UrlToBuffer,
  decodePartText,
  getHeader,
  htmlToText,
  type EmailAttachment,
  type InlineImagePart,
} from "./email.js";

// Gmail's documented send limit is 25 MB, measured against the RFC822 MIME
// message (headers + body, before any transport-level encoding the API does
// on top). The API's actual JSON-request-body ceiling for the base64url
// `raw` field is unverified/undocumented, so rather than guess at that we
// gate on the 25 MB MIME-message threshold Gmail itself publishes.
export const GMAIL_MAX_SEND_BYTES = 25 * 1024 * 1024;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal plain-text -> HTML conversion: escape, then turn newlines into <br>. Used only to derive an HTML body when the original had none. */
function minimalTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/** Subject becomes "Fwd: <original>" unless it already starts with Fwd:/Fw:/FW: (case-insensitive). */
export function buildForwardSubject(originalSubject: string): string {
  const trimmed = originalSubject.trim();
  return /^fwd?:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

/** The original message's header fields shown in the forwarded-message block. */
export interface ForwardHeaderFields {
  from: string;
  date: string;
  subject: string;
  to: string;
  cc?: string;
}

const FORWARD_DIVIDER = "---------- Forwarded message ---------";

/** Builds Gmail's forwarded-message header block (text + HTML, HTML-escaped) from the original message's From/Date/Subject/To/Cc. */
export function buildForwardHeaderBlock(fields: ForwardHeaderFields): { text: string; html: string } {
  const rows: Array<[string, string]> = [
    ["From", fields.from],
    ["Date", fields.date],
    ["Subject", fields.subject],
    ["To", fields.to],
    ...(fields.cc ? ([["Cc", fields.cc]] as Array<[string, string]>) : []),
  ];

  const text = [FORWARD_DIVIDER, ...rows.map(([name, value]) => `${name}: ${value}`)].join("\n");
  const html = `<div class="gmail_quote">${[
    FORWARD_DIVIDER,
    ...rows.map(([name, value]) => `${name}: ${escapeHtml(value)}`),
  ].join("<br>")}</div>`;

  return { text, html };
}

/**
 * Fills in whichever of text/html the original lacked, deriving it minimally
 * from the other. Leaves both alone when both (or neither) are present.
 *
 * The derived text/plain alternative goes through htmlToText's *uncapped*
 * form (maxLength: Infinity) — htmlToText's default 50k display cap exists
 * for a body shown to an LLM caller, not for a MIME part that's about to be
 * attached to an outgoing message; capping it here would silently truncate
 * the forwarded email's plain-text alternative and append a "[truncated: …]"
 * note into the message itself.
 */
export function deriveMissingBodyPart(original: { text: string; html: string }): { text: string; html: string } {
  let { text, html } = original;
  if (!html && text) html = minimalTextToHtml(text);
  else if (!text && html) text = htmlToText(html, Infinity);
  return { text, html };
}

/** Assembles the full forward body: note, then signature, then the forwarded-message header block, then the original body — in both text and HTML. */
export function buildForwardBody(opts: {
  note?: string;
  signature?: { text: string; html: string };
  header: { text: string; html: string };
  original: { text: string; html: string };
}): { text: string; html: string } {
  const noteText = opts.note ? `${opts.note}\n\n` : "";
  const sigText = opts.signature ? `${opts.signature.text}\n\n` : "";
  const text = `${noteText}${sigText}${opts.header.text}\n\n${opts.original.text}`;

  const noteHtml = opts.note ? `<div>${minimalTextToHtml(opts.note)}</div><br>` : "";
  const sigHtml = opts.signature ? `<div>${opts.signature.html}</div><br>` : "";
  const html = `<div dir="ltr">${noteHtml}${sigHtml}${opts.header.html}<br>${opts.original.html}</div>`;

  return { text, html };
}

/** One leaf part of the original message found while walking its MIME tree: an inline (cid:) image or a regular attachment, with bytes either already inline (small parts) or needing a follow-up attachments.get fetch. */
export interface ForwardAttachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Set when the bytes must be fetched via users.messages.attachments.get; absent when already inline below. */
  attachmentId?: string;
  /** Standard base64 bytes, when Gmail returned them inline on the part itself. */
  contentBase64?: string;
  /** Content-ID header value — present only for inline (cid:) images. */
  contentId?: string;
}

export interface ParsedForwardContent {
  text: string;
  html: string;
  inlineImages: ForwardAttachment[];
  attachments: ForwardAttachment[];
  /** Non-fatal issues found while walking the MIME tree (e.g. a part that couldn't be kept at all). Surfaced to the caller as a warning, never thrown. */
  warnings: string[];
}

/** Strips angle brackets (and surrounding whitespace) off a Content-ID header value, for comparing it against a bare `cid:...` reference in HTML. */
function bareContentId(id: string): string {
  return id.trim().replace(/^</, "").replace(/>$/, "").trim();
}

/** True when `html` contains a `cid:` reference to `contentId`, case-insensitively and regardless of the header's own angle-bracket formatting. */
function htmlReferencesCid(html: string, contentId: string): boolean {
  const bare = bareContentId(contentId).toLowerCase();
  return bare.length > 0 && html.toLowerCase().includes(`cid:${bare}`);
}

/** True when a Content-Disposition header value explicitly says "attachment" (as opposed to "inline" or being absent). */
function isExplicitAttachmentDisposition(value: string): boolean {
  return /^\s*attachment/i.test(value);
}

/** Minimal filename-extension guess from a MIME type's subtype (e.g. "image/png" -> "png"), used only to name a leaf part that arrived with no filename at all. */
function extFromMimeType(mimeType: string): string {
  const subtype = (mimeType.split("/")[1] || "bin").split("+")[0].replace(/^x-/, "");
  return subtype || "bin";
}

/** One leaf part found while walking the MIME tree, before classification (inline vs. attachment) and filename resolution — both of which depend on having walked the *entire* tree first (classification needs the fully-collected HTML; a calendar alternative needs to know whether an attached duplicate exists elsewhere). */
interface RawLeaf {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  /** Raw base64url bytes, undecoded, when Gmail returned them inline on the part itself. */
  data?: string;
  contentId?: string;
  isAttachmentDisposition: boolean;
  /** A text/calendar part that is itself a body alternative (directly under multipart/alternative), not a standalone attachment part. */
  isCalendarAlternative: boolean;
  /** message/rfc822 or message/delivery-status — always an attachment leaf, never walked into for body text. */
  isMessageContainer: boolean;
}

/**
 * Walks a message's MIME part tree collecting its text/plain and text/html
 * bodies (decoded per each part's own Content-Type charset) plus every leaf
 * attachment. Recurses through arbitrary multipart nesting (mixed >
 * alternative, mixed > related > alternative + inline images, etc.) rather
 * than assuming one shape.
 *
 * Classification (inline image vs. regular attachment) happens only after
 * the whole tree — and so the full HTML body — has been collected: a part is
 * an inline image only if it carries a Content-ID that the collected HTML
 * actually references via `cid:`, and only if it isn't marked
 * Content-Disposition: attachment. Everything else with a Content-ID (e.g. a
 * PDF some mail clients tag with one) is a regular attachment.
 *
 * message/rfc822 and message/delivery-status parts are always kept as
 * attachment leaves (never walked into for body text, to avoid merging an
 * inner forwarded/bounced message's text into the outer body); an rfc822
 * part with no attachmentId and no inline data is reported via `warnings`
 * rather than silently dropped.
 *
 * A non-text leaf with fetchable bytes but an empty filename (a bare inline
 * image, a nameless calendar alternative, a nameless forwarded message) is
 * kept rather than dropped, under a generated filename.
 */
export function parseForwardContent(payload: gmail_v1.Schema$MessagePart | undefined): ParsedForwardContent {
  const result: ParsedForwardContent = { text: "", html: "", inlineImages: [], attachments: [], warnings: [] };
  if (!payload) return result;

  const rawLeaves: RawLeaf[] = [];

  function walk(part: gmail_v1.Schema$MessagePart, parentMimeType?: string): void {
    const mimeType = part.mimeType || "application/octet-stream";
    const isMessageContainer = mimeType === "message/rfc822" || mimeType === "message/delivery-status";
    const isBodyAlternative = (mimeType === "text/plain" || mimeType === "text/html") && !part.filename && !!part.body?.data;

    // Container: recurse into children. message/rfc822 (and delivery-status)
    // are excluded even though they may carry `.parts` of their own — those
    // are the *inner* message's MIME tree, which must stay un-walked.
    if (!isMessageContainer && !isBodyAlternative && mimeType !== "text/calendar" && part.parts) {
      for (const child of part.parts) walk(child, mimeType);
      return;
    }

    if (isBodyAlternative) {
      const decoded = decodePartText(part.body!.data!, part.headers);
      if (mimeType === "text/plain") result.text += decoded;
      else result.html += decoded;
      return;
    }

    // Leaf. Keep it only if there are bytes to fetch or already inline;
    // otherwise there's nothing to attach. A message container with no
    // bytes at all is still worth flagging, since silently dropping a
    // forwarded/bounced message is easy to miss.
    const hasBytes = !!part.body?.attachmentId || !!part.body?.data;
    if (!hasBytes) {
      if (isMessageContainer) {
        result.warnings.push(`Dropped a ${mimeType} part with no attachment data (no attachmentId and no inline body data).`);
      }
      return;
    }

    rawLeaves.push({
      filename: part.filename || "",
      mimeType,
      size: part.body?.size || 0,
      attachmentId: part.body?.attachmentId || undefined,
      data: part.body?.data || undefined,
      contentId: getHeader(part.headers, "content-id") || undefined,
      isAttachmentDisposition: isExplicitAttachmentDisposition(getHeader(part.headers, "content-disposition")),
      isCalendarAlternative: mimeType === "text/calendar" && parentMimeType === "multipart/alternative",
      isMessageContainer,
    });
  }

  walk(payload);

  let namelessCounter = 0;
  function resolvedFilename(leaf: RawLeaf): string {
    if (leaf.filename) return leaf.filename;
    if (leaf.isCalendarAlternative) return "invite.ics";
    if (leaf.mimeType === "message/rfc822") return "forwarded-message.eml";
    if (leaf.mimeType === "message/delivery-status") return "delivery-status.txt";
    if (leaf.contentId) return `${bareContentId(leaf.contentId)}.${extFromMimeType(leaf.mimeType)}`;
    namelessCounter += 1;
    return `attachment-${namelessCounter}.${extFromMimeType(leaf.mimeType)}`;
  }

  // text/calendar body alternatives are classified last, since whether they
  // survive depends on whether an attached duplicate of the same invite
  // already made it into `attachments` from a sibling leaf.
  const calendarEntries: ForwardAttachment[] = [];

  for (const leaf of rawLeaves) {
    const entry: ForwardAttachment = {
      filename: resolvedFilename(leaf),
      mimeType: leaf.mimeType,
      size: leaf.size,
      attachmentId: leaf.attachmentId,
      // Decode as raw bytes (base64url -> buffer), not as UTF-8 text — these
      // may be binary attachment bytes, and a UTF-8 round-trip would corrupt
      // anything that isn't valid UTF-8.
      contentBase64: leaf.data ? decodeBase64UrlToBuffer(leaf.data).toString("base64") : undefined,
      contentId: leaf.contentId,
    };

    if (leaf.isCalendarAlternative) {
      calendarEntries.push(entry);
      continue;
    }

    const isInline = !!leaf.contentId && !leaf.isAttachmentDisposition && htmlReferencesCid(result.html, leaf.contentId);
    if (isInline) result.inlineImages.push(entry);
    else result.attachments.push(entry);
  }

  // Calendar mail (e.g. Google Calendar) carries the same invite.ics twice: as a
  // text/calendar body alternative and as an attachment. Forward it once.
  for (const cal of calendarEntries) {
    const attachedToo = result.attachments.some((a) => a.filename === cal.filename && a.size === cal.size);
    if (!attachedToo) result.attachments.push(cal);
  }
  return result;
}

/** Drops the regular-attachment list when includeAttachments is false. Inline images are always kept — they're part of the rendered body, not an optional extra. */
export function selectForwardAttachments(
  parsed: ParsedForwardContent,
  includeAttachments: boolean
): { inlineImages: ForwardAttachment[]; attachments: ForwardAttachment[] } {
  return { inlineImages: parsed.inlineImages, attachments: includeAttachments ? parsed.attachments : [] };
}

export interface BuildForwardRawEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  originalSubject: string;
  originalHeaderFields: ForwardHeaderFields;
  note?: string;
  signature?: { text: string; html: string };
  originalBody: { text: string; html: string };
  inlineImages: InlineImagePart[];
  attachments: EmailAttachment[];
  inReplyTo?: string;
  references?: string;
}

/** Builds the full raw RFC822 forward message: Fwd: subject, forwarded-message header block, note + signature, original text/html bodies, inline images, and attachments — threaded via inReplyTo/references exactly like gmail_reply_to_email. */
export function buildForwardRawEmail(opts: BuildForwardRawEmailOptions): string {
  const subject = buildForwardSubject(opts.originalSubject);
  const header = buildForwardHeaderBlock(opts.originalHeaderFields);
  const original = deriveMissingBodyPart(opts.originalBody);
  const body = buildForwardBody({ note: opts.note, signature: opts.signature, header, original });

  return buildRawEmail({
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject,
    body: body.text,
    htmlBody: body.html,
    mimeType: "multipart/alternative",
    inlineImages: opts.inlineImages,
    attachments: opts.attachments,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
}

export interface ForwardSizeCheck {
  ok: boolean;
  totalBytes: number;
  limitBytes: number;
}

/**
 * Checks the raw RFC822 MIME message (the string buildForwardRawEmail
 * returns, *before* it's base64url-encoded for the API's `raw` field)
 * against Gmail's documented 25 MB send limit. That limit is published
 * against the MIME message itself, not the subsequent base64url transport
 * encoding (which runs ~33% larger) — checking the encoded string instead
 * would refuse forwards Gmail's own web UI happily sends.
 */
export function checkForwardRawSize(raw: string, limitBytes = GMAIL_MAX_SEND_BYTES): ForwardSizeCheck {
  const totalBytes = Buffer.byteLength(raw, "utf-8");
  return { ok: totalBytes <= limitBytes, totalBytes, limitBytes };
}

export interface ForwardSizeEstimate {
  ok: boolean;
  estimatedBytes: number;
  limitBytes: number;
}

/**
 * Cheap pre-download estimate of the final MIME message size, computed from
 * Gmail's already-known `body.size` for each selected inline-image/attachment
 * part (pre-base64, so scaled by the ~4/3 base64 expansion it'll undergo)
 * plus the already-known text/html body byte lengths — all available before
 * fetching a single attachment byte. Lets a forward that's already too big
 * be refused without downloading megabytes of attachment data first just to
 * throw it away.
 */
export function estimateForwardSize(
  parts: Array<{ size: number }>,
  bodyBytes: number,
  limitBytes = GMAIL_MAX_SEND_BYTES
): ForwardSizeEstimate {
  const attachmentBytes = parts.reduce((sum, p) => sum + Math.ceil((p.size || 0) * (4 / 3)), 0);
  const estimatedBytes = attachmentBytes + bodyBytes;
  return { ok: estimatedBytes <= limitBytes, estimatedBytes, limitBytes };
}

/** The N largest items by size, for naming in a too-large-to-send error. */
export function largestAttachments(
  items: Array<{ filename: string; size: number }>,
  limit = 5
): Array<{ filename: string; size: number }> {
  return [...items].sort((a, b) => b.size - a.size).slice(0, limit);
}
