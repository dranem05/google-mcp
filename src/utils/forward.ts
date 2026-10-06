import { gmail_v1 } from "googleapis";
import {
  buildRawEmail,
  decodeBase64Url,
  decodeBase64UrlToBuffer,
  getHeader,
  htmlToText,
  type EmailAttachment,
  type InlineImagePart,
} from "./email.js";

/** Gmail's own send-size ceiling (RFC822 bytes of the base64url-encoded raw message). */
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

/** Fills in whichever of text/html the original lacked, deriving it minimally from the other. Leaves both alone when both (or neither) are present. */
export function deriveMissingBodyPart(original: { text: string; html: string }): { text: string; html: string } {
  let { text, html } = original;
  if (!html && text) html = minimalTextToHtml(text);
  else if (!text && html) text = htmlToText(html);
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
}

/**
 * Walks a message's MIME part tree collecting its text/plain and text/html
 * bodies plus every leaf attachment, classifying each leaf as an inline (cid:)
 * image or a regular attachment by the presence of a Content-ID header.
 * Recurses through arbitrary multipart nesting (mixed > alternative, mixed >
 * related > alternative + inline images, etc.) rather than assuming one shape.
 */
export function parseForwardContent(payload: gmail_v1.Schema$MessagePart | undefined): ParsedForwardContent {
  const result: ParsedForwardContent = { text: "", html: "", inlineImages: [], attachments: [] };
  if (!payload) return result;

  // text/calendar parts that are a body alternative of an invite/RSVP, kept
  // aside so they can be dropped when the same .ics is also attached.
  const calendarAlternatives: ForwardAttachment[] = [];

  function walk(part: gmail_v1.Schema$MessagePart, parentMimeType?: string): void {
    const isLeafFile = !!part.filename && part.filename.length > 0 && (!!part.body?.attachmentId || !!part.body?.data);
    if (isLeafFile) {
      const contentId = getHeader(part.headers, "content-id") || undefined;
      const entry: ForwardAttachment = {
        filename: part.filename!,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size || 0,
        attachmentId: part.body?.attachmentId || undefined,
        // Decode as raw bytes (base64url -> buffer), not as UTF-8 text —
        // these may be binary attachment bytes, and decodeBase64Url's UTF-8
        // round-trip would corrupt anything that isn't valid UTF-8.
        contentBase64: part.body?.data ? decodeBase64UrlToBuffer(part.body.data).toString("base64") : undefined,
        contentId,
      };
      if (contentId) result.inlineImages.push(entry);
      else if (entry.mimeType === "text/calendar" && parentMimeType === "multipart/alternative") calendarAlternatives.push(entry);
      else result.attachments.push(entry);
      return;
    }

    if (part.mimeType === "text/plain" && part.body?.data) {
      result.text += decodeBase64Url(part.body.data);
      return;
    }
    if (part.mimeType === "text/html" && part.body?.data) {
      result.html += decodeBase64Url(part.body.data);
      return;
    }

    if (part.parts) {
      for (const child of part.parts) walk(child, part.mimeType || undefined);
    }
  }

  walk(payload);
  // Calendar mail (e.g. Google Calendar) carries the same invite.ics twice: as a
  // text/calendar body alternative and as an attachment. Forward it once.
  for (const cal of calendarAlternatives) {
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

/** Checks the final base64url-encoded raw message against Gmail's send-size ceiling. Must be run on the actual encoded string that would be POSTed, since that (not the pre-encoding MIME text) is what the limit applies to. */
export function checkForwardRawSize(encodedRaw: string, limitBytes = GMAIL_MAX_SEND_BYTES): ForwardSizeCheck {
  const totalBytes = Buffer.byteLength(encodedRaw, "utf-8");
  return { ok: totalBytes <= limitBytes, totalBytes, limitBytes };
}

/** The N largest items by size, for naming in a too-large-to-send error. */
export function largestAttachments(
  items: Array<{ filename: string; size: number }>,
  limit = 5
): Array<{ filename: string; size: number }> {
  return [...items].sort((a, b) => b.size - a.size).slice(0, limit);
}
