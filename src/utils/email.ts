import { gmail_v1 } from "googleapis";
import { defaultTreeAdapter, html as parse5Html, parse, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes, type TreeAdapter } from "parse5";

/** Decodes a Gmail base64url string to raw bytes (safe for binary content like attachments). */
export function decodeBase64UrlToBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function decodeBase64Url(data: string): string {
  return decodeBase64UrlToBuffer(data).toString("utf-8");
}

export function encodeBase64Url(data: string): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): { text: string; html: string } {
  if (!payload) return { text: "", html: "" };

  let text = "";
  let html = "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        text += decodeBase64Url(part.body.data);
      } else if (part.mimeType === "text/html" && part.body?.data) {
        html += decodeBase64Url(part.body.data);
      } else if (part.mimeType?.startsWith("multipart/") && part.parts) {
        const nested = extractBody(part);
        text += nested.text;
        html += nested.html;
      }
    }
  }

  return { text, html };
}

export function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

/** Extracts the charset parameter from a Content-Type header value (e.g. 'text/plain; charset="iso-8859-1"'), if present. */
function extractCharset(contentType: string): string | undefined {
  const m = /charset\s*=\s*"?([^;"]+)"?/i.exec(contentType);
  return m ? m[1].trim() : undefined;
}

/**
 * Decodes a MIME part's base64url body data as text, honoring the part's own
 * Content-Type charset parameter (e.g. a non-UTF-8 sender like iso-8859-1)
 * via TextDecoder, then returns a normal JS string (UTF-8 internally, as all
 * JS strings are). Falls back to plain UTF-8 decoding when the part declares
 * no charset, declares utf-8, or names a charset TextDecoder doesn't
 * recognize.
 */
export function decodePartText(data: string, headers: gmail_v1.Schema$MessagePartHeader[] | undefined): string {
  const buf = decodeBase64UrlToBuffer(data);
  const charset = extractCharset(getHeader(headers, "content-type"));
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // Unrecognized/unsupported charset label -> fall back to UTF-8 below.
    }
  }
  return buf.toString("utf-8");
}

/** Strips CR/LF out of a header value so it can't inject additional header lines (or a body separator). */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * RFC 2047-encodes a header value if it contains any non-ASCII characters
 * (e.g. "=?UTF-8?B?...?="), after stripping CR/LF. ASCII-only values are
 * returned unchanged (untouched, unencoded) so the common case stays
 * human-readable in the raw message.
 */
function encodeHeaderValue(value: string): string {
  const sanitized = sanitizeHeaderValue(value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf-8").toString("base64")}?=`;
}

/** Free-text header (Subject etc.): CRLF-sanitized and RFC 2047-encoded when non-ASCII. */
function header(name: string, value: string): string {
  return `${name}: ${encodeHeaderValue(value)}`;
}

/**
 * Address header (To/Cc/Bcc/From): CRLF-sanitized only. RFC 2047
 * encoded-words are not allowed inside an addr-spec, so base64-encoding the
 * whole value would swallow the email address into an opaque blob and break
 * parsing/delivery. Non-ASCII display names pass through as raw UTF-8,
 * which Gmail accepts (SMTPUTF8) — imperfect for strict RFC 5322 relays,
 * but strictly better than corrupting the address.
 */
function addressHeader(name: string, value: string): string {
  return `${name}: ${sanitizeHeaderValue(value)}`;
}

/** Wraps a base64 string into CRLF-separated 76-character lines (RFC 2045 §6.8). */
function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * Base64-encodes a MIME body part so arbitrarily long lines in the source
 * text (which would otherwise violate RFC 5322's 998-octet line limit)
 * become short, safe base64 lines instead.
 */
function encodeBodyBase64(text: string): string {
  return wrapBase64(Buffer.from(text, "utf-8").toString("base64"));
}

/** An email attachment, already base64-encoded (standard base64, not URL-safe). */
export interface EmailAttachment {
  filename: string;
  mimeType: string;
  /** Standard base64 of the raw bytes. Whitespace is stripped before (re)wrapping to 76-char lines. */
  contentBase64: string;
}

/**
 * Renders just the MIME "body part" — a Content-Type/Content-Transfer-Encoding
 * header block plus the encoded body — without any message-level (To/From/…)
 * headers. Returned as a self-contained part so it can be used either at the
 * top level of a message or nested inside a multipart/mixed container (when
 * attachments are present).
 */
function renderBodyPart(opts: { body: string; htmlBody?: string; mimeType?: string }): string {
  if (opts.htmlBody && opts.mimeType === "multipart/alternative") {
    const boundary = `alt_${Date.now()}`;
    const parts = [
      `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeBodyBase64(opts.body)}`,
      `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeBodyBase64(opts.htmlBody)}`,
      `--${boundary}--`,
    ];
    return `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` + parts.join("\r\n");
  }

  if (opts.htmlBody || opts.mimeType === "text/html") {
    return `Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeBodyBase64(opts.htmlBody || opts.body)}`;
  }

  return `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodeBodyBase64(opts.body)}`;
}

/** Renders one attachment as a base64 MIME part with a Content-Disposition: attachment header. */
function renderAttachmentPart(att: EmailAttachment): string {
  // The filename lands in two structured header params; strip CR/LF (and any
  // stray quotes) so it can't break out of the quoted-string or inject headers.
  const filename = sanitizeHeaderValue(att.filename).replace(/"/g, "");
  const mimeType = sanitizeHeaderValue(att.mimeType) || "application/octet-stream";
  const body = wrapBase64(att.contentBase64.replace(/\s+/g, ""));
  return (
    `Content-Type: ${mimeType}; name="${filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
    body
  );
}

/** An inline image part (e.g. a forwarded `<img src="cid:...">`): an attachment plus the Content-ID header that cid: references in the HTML body point at. */
export interface InlineImagePart extends EmailAttachment {
  /** RFC 2392 Content-ID header value. Normalized to include the angle brackets regardless of how it was supplied. */
  contentId: string;
}

/** Wraps a bare id in angle brackets if it doesn't already have them, since RFC 2392 Content-ID values are always delimited. */
function normalizeContentId(id: string): string {
  const trimmed = sanitizeHeaderValue(id);
  if (!trimmed) return trimmed;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/** The MIME type of the "root" body part that a multipart/related wrapper would contain — text/html or multipart/alternative when there's an HTML body, text/plain otherwise. Used for RFC 2387's required `type` parameter. */
function rootPartMimeType(opts: { htmlBody?: string; mimeType?: string }): string {
  if (opts.htmlBody && opts.mimeType === "multipart/alternative") return "multipart/alternative";
  if (opts.htmlBody || opts.mimeType === "text/html") return "text/html";
  return "text/plain";
}

/** Renders one inline image as a base64 MIME part with Content-ID + Content-Disposition: inline, so cid: references in the HTML body resolve. */
function renderInlineImagePart(img: InlineImagePart): string {
  const filename = sanitizeHeaderValue(img.filename).replace(/"/g, "");
  const mimeType = sanitizeHeaderValue(img.mimeType) || "application/octet-stream";
  const contentId = normalizeContentId(img.contentId);
  const body = wrapBase64(img.contentBase64.replace(/\s+/g, ""));
  return (
    `Content-Type: ${mimeType}${filename ? `; name="${filename}"` : ""}\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-ID: ${contentId}\r\n` +
    `Content-Disposition: inline${filename ? `; filename="${filename}"` : ""}\r\n\r\n` +
    body
  );
}

export function buildRawEmail(opts: {
  to: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  cc?: string[];
  bcc?: string[];
  from?: string;
  inReplyTo?: string;
  references?: string;
  mimeType?: string;
  attachments?: EmailAttachment[];
  /** Inline (cid:) images referenced from htmlBody. Wraps the body part in multipart/related, Gmail's own shape for this. */
  inlineImages?: InlineImagePart[];
}): string {
  const headers: string[] = [];

  headers.push(addressHeader("To", opts.to.join(", ")));
  if (opts.from) headers.push(addressHeader("From", opts.from));
  if (opts.cc?.length) headers.push(addressHeader("Cc", opts.cc.join(", ")));
  if (opts.bcc?.length) headers.push(addressHeader("Bcc", opts.bcc.join(", ")));
  headers.push(header("Subject", opts.subject));
  if (opts.inReplyTo) {
    // Message-ID references are ASCII identifiers; sanitize only.
    headers.push(addressHeader("In-Reply-To", opts.inReplyTo));
    headers.push(addressHeader("References", opts.references || opts.inReplyTo));
  }
  headers.push(`MIME-Version: 1.0`);

  const bodyPart = renderBodyPart(opts);

  // Inline images wrap the body part in multipart/related so cid: references
  // in the HTML keep resolving. Skipped entirely when there are none, so the
  // no-inline-images path (every existing caller) is untouched.
  const contentPart = opts.inlineImages?.length
    ? (() => {
        const boundary = `related_${Date.now()}`;
        const parts = [bodyPart, ...opts.inlineImages!.map(renderInlineImagePart)];
        // RFC 2387 requires the `type` parameter on multipart/related, naming
        // the MIME type of the root (first) body part.
        const rootType = rootPartMimeType(opts);
        return (
          `Content-Type: multipart/related; boundary="${boundary}"; type="${rootType}"\r\n\r\n` +
          parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") +
          `\r\n--${boundary}--`
        );
      })()
    : bodyPart;

  // With attachments, wrap the content part + each attachment in multipart/mixed.
  // The "mixed_"/"alt_"/"related_" boundary prefixes contain "_" (not in the
  // base64 alphabet), so a boundary delimiter can never collide with encoded content.
  if (opts.attachments?.length) {
    const boundary = `mixed_${Date.now()}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [contentPart, ...opts.attachments.map(renderAttachmentPart)];
    const body = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--`;
    return headers.join("\r\n") + "\r\n\r\n" + body;
  }

  // No attachments: the content part's Content-* headers sit at the message top level.
  return headers.join("\r\n") + "\r\n" + contentPart;
}

/** RFC 822 headers of the message being replied to (values as returned by Gmail's metadata format). */
export interface OriginalMessageHeaders {
  /** The original message's RFC 822 Message-ID header value, e.g. "<abc@mail.gmail.com>". */
  messageIdHeader: string;
  /** The original References header value (may be empty). */
  references: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
}

export interface ReplyHeaders {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo: string;
  references: string;
}

/** Extracts the addr-spec from one address token ("Name <a@b.com>" -> "a@b.com"). */
export function extractEmailAddress(token: string): string {
  const angle = token.match(/<([^>]+)>/);
  return (angle ? angle[1] : token).trim();
}

/**
 * Splits an address-list header value into bare email addresses, respecting
 * commas that appear inside quoted display names or angle brackets.
 */
export function parseAddressList(headerValue: string): string[] {
  if (!headerValue) return [];
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of headerValue) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuote && !inAngle) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  tokens.push(current);
  return tokens.map(extractEmailAddress).filter((a) => a.length > 0);
}

/**
 * Builds RFC 5322-compliant reply headers from the original message's headers:
 * threads the reply via In-Reply-To + a References chain, prefixes the subject
 * with "Re:" (unless it already has one), and computes recipients. A plain
 * reply goes only to the original sender; reply-all additionally CCs the
 * original To + Cc recipients, minus the sender (already in To) and minus the
 * authenticated user (selfEmail).
 */
export function buildReplyHeaders(
  original: OriginalMessageHeaders,
  opts: { replyAll?: boolean; selfEmail?: string | string[] } = {}
): ReplyHeaders {
  const to = parseAddressList(original.from);
  const senderLower = new Set(to.map((a) => a.toLowerCase()));
  const selfLower = new Set(
    [opts.selfEmail ?? []].flat().map((a) => a.toLowerCase())
  );

  const cc: string[] = [];
  if (opts.replyAll) {
    const seen = new Set<string>();
    for (const addr of [...parseAddressList(original.to), ...parseAddressList(original.cc)]) {
      const lower = addr.toLowerCase();
      if (selfLower.has(lower)) continue; // don't reply to yourself
      if (senderLower.has(lower)) continue; // already in To
      if (seen.has(lower)) continue;
      seen.add(lower);
      cc.push(addr);
    }
  }

  const trimmedSubject = original.subject.trim();
  const subject = /^re:/i.test(trimmedSubject) ? trimmedSubject : `Re: ${trimmedSubject}`;

  const references = buildReferencesChain(original.references, original.messageIdHeader);

  return { to, cc, subject, inReplyTo: original.messageIdHeader, references };
}

/**
 * Extends a References chain with the message being threaded off of: appends
 * messageIdHeader to the original References header, or falls back to just
 * messageIdHeader when there was no prior chain (the first reply/forward in
 * a thread). Shared by buildReplyHeaders and gmail_forward_email so both
 * tools thread identically.
 */
export function buildReferencesChain(originalReferences: string, messageIdHeader: string): string {
  return originalReferences ? `${originalReferences.trim()} ${messageIdHeader}`.trim() : messageIdHeader;
}

export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentInfo[] {
  if (!payload) return [];
  const attachments: AttachmentInfo[] = [];

  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  }

  walk(payload);
  return attachments;
}

const DEFAULT_BODY_TEXT_MAX_LENGTH = 50_000;

/**
 * Caps `text` at `maxLength` characters, appending a truncation note when
 * anything was cut. Shared by the HTML-fallback path and plain-text bodies
 * so a huge email of either kind can't blow past response size limits.
 */
export function capTextLength(text: string, maxLength = DEFAULT_BODY_TEXT_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  const shown = text.slice(0, maxLength);
  return `${shown}\n\n[truncated: showing ${maxLength} of ${text.length} characters]`;
}

/** Elements whose content is never shown as part of the body. */
const HIDDEN_ELEMENTS = new Set([
  // Document metadata: the title, styles and meta/link/base tags live here.
  "head", "title", "style", "script",
  // Inert or fallback content: a template is never rendered; the parser keeps
  // iframe, noembed and noframes content as raw markup text, which no reader
  // sees. noscript is not here: mail clients run without scripts and show it.
  "template", "iframe", "noembed", "noframes",
]);

/**
 * Elements that start and end on their own line (CSS `display: block`,
 * `list-item` or a table box in the HTML rendering rules). A paragraph is
 * set off by a blank line, as in plain-text mail.
 */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details",
  "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "legend", "li",
  "listing", "main", "menu", "nav", "ol", "p", "plaintext", "pre", "search", "section", "summary",
  "table", "tbody", "tfoot", "thead", "tr", "ul", "xmp",
]);

/** Elements whose text keeps its whitespace and line breaks. */
const PREFORMATTED_ELEMENTS = new Set(["pre", "listing", "plaintext", "xmp", "textarea"]);

/**
 * Link schemes shown in their readable form: URLs as a browser loads them,
 * addresses and numbers bare. Any other target (javascript:, data:, an app
 * handler, or a relative href with no usable <base>) is shown as written.
 */
const LINK_SCHEMES = new Set(["http:", "https:", "webcal:", "mailto:", "tel:", "sms:"]);

/**
 * Percent-encodes everything but printable ASCII (spaces too, unless
 * `keepSpaces`), and `<` `>`, so a target cannot be disguised or break out of
 * its `<target>`.
 */
function displaySafe(s: string, keepSpaces = false): string {
  return s.replace(keepSpaces ? /[^\x20-\x7E]|[<>]/gu : /[^\x21-\x7E]|[<>]/gu, (c) => {
    try {
      return encodeURIComponent(c);
    } catch {
      return "%EF%BF%BD";
    }
  });
}

/**
 * Percent-decodes `s` for display, then re-encodes it with displaySafe, so
 * control, bidi-override, zero-width and line separator characters cannot
 * reorder, hide or forge what is shown. Spaces are kept only where
 * `keepSpaces` (phone numbers); in an address a decoded space could forge a
 * label such as `, cc: `.
 */
function displayDecoded(s: string, keepSpaces = false): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    decoded = s;
  }
  return displaySafe(decoded.trim(), keepSpaces);
}

/**
 * The part of a mailto, tel or sms URL after the scheme, up to any query: the
 * opaque path (`tel:+1555…`), or, written with `//`, the authority and path
 * the URL parser splits it into (`tel://+1555…`, `mailto://user@host`).
 */
function opaqueBody(url: URL): string {
  // In the serialized URL the first `?` or `#` starts the query or fragment.
  let body = url.href.slice(url.protocol.length).split(/[?#]/)[0];
  if (body.startsWith("//")) {
    body = body.slice(2);
    if (url.pathname === "/") body = body.slice(0, -1);
  }
  return body;
}

/**
 * Every recipient of a mailto link: the address part plus any to, cc and bcc
 * query fields, so a link cannot hide where it really sends. Query values are
 * split by hand because URLSearchParams would turn `+` (valid in an address)
 * into a space.
 */
function mailtoRecipients(url: URL): string | undefined {
  const recipients: string[] = [];
  const path = displayDecoded(opaqueBody(url));
  if (path) recipients.push(path);
  for (const field of url.search.slice(1).split("&")) {
    const eq = field.indexOf("=");
    const name = displayDecoded(eq < 0 ? field : field.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? "" : displayDecoded(field.slice(eq + 1));
    if (!value) continue;
    if (name === "to") recipients.push(value);
    else if (name === "cc" || name === "bcc") recipients.push(`${name}: ${value}`);
  }
  return recipients.length ? recipients.join(", ") : undefined;
}

/**
 * A target shown as written, display-safe. A data: URL carries content rather
 * than a destination and can run to megabytes, so only its header (media type
 * and encoding, up to the comma) is shown, with an ellipsis for the payload.
 * Every other target is shown in full, since a host can sit anywhere in it.
 */
function rawTarget(s: string): string {
  const header = /^data:[^,]*,(?=.)/is.exec(s);
  return header ? `${displaySafe(header[0])}\u2026` : displaySafe(s);
}

/**
 * A parsed link target in its shown form: outside LINK_SCHEMES as written
 * (rawTarget); addresses and numbers bare; URLs as the browser would load
 * them. Any `user:password@` part is dropped, since it only serves to make a
 * link to one host read like another (`https://bank.example@evil.test/`).
 * A mailto with no recipient (only a subject, say) has none.
 */
function shownTarget(url: URL): string | undefined {
  if (!LINK_SCHEMES.has(url.protocol)) {
    if (url.host) {
      url.username = "";
      url.password = "";
    }
    return rawTarget(url.href);
  }
  if (url.protocol === "mailto:") return mailtoRecipients(url);
  if (url.protocol === "tel:" || url.protocol === "sms:") return displayDecoded(opaqueBody(url), true) || undefined;
  url.username = "";
  url.password = "";
  // Special schemes (http, https) are already serialized percent-encoded; an
  // opaque webcal: URL is not.
  return displaySafe(url.href);
}

/**
 * Where a link goes, bracketed, as shown after its text so the reader can
 * compare the two: link text can imitate any URL. The href is resolved the
 * way a browser resolves it (WHATWG URL parsing, so `https:host`, backslashes
 * and entity-encoded schemes reach their real destination), against the
 * document's <base> when it has one, since a client that honors <base> sends
 * relative, fragment-only and empty hrefs there. A same-scheme `https:host`
 * is relative to an https <base> but absolute to a client that ignores it, so
 * when the two readings differ both are shown: `<base reading> or <other>`.
 * With no <base>, a scheme-relative `//host/path` is taken as https and any
 * other relative href is shown as written. An empty href with no <base>
 * points back at the message itself and gets no target.
 */
function linkTarget(href: string, base: URL | undefined): string | undefined {
  // What the URL parser ignores: tabs and newlines anywhere, controls and spaces at the ends.
  const written = href.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  let url: URL;
  try {
    url = base ? new URL(written, base) : new URL(written);
  } catch {
    if (base || !/^[\\/]{2}/.test(written)) return written ? `<${rawTarget(written)}>` : undefined;
    try {
      url = new URL(written, "https://scheme-relative.invalid/");
    } catch {
      return `<${rawTarget(written)}>`;
    }
  }
  const shown = shownTarget(url);
  let alone: string | undefined;
  if (base) {
    try {
      alone = shownTarget(new URL(written));
    } catch {
      // Relative without the base: it reaches no other destination.
    }
  }
  const targets = [...new Set([shown, alone].filter((t) => t !== undefined))];
  return targets.length ? targets.map((t) => `<${t}>`).join(" or ") : undefined;
}

/**
 * Accumulates rendered text with HTML's whitespace rules: runs of whitespace
 * in ordinary text collapse to one space, spaces at line edges disappear,
 * and line breaks requested by adjacent block boundaries merge into the
 * largest one rather than adding up. Breaks and spaces are held until the
 * next text, so a link's target can still be placed right after its text.
 */
class TextSink {
  private parts: string[] = [];
  private started = false;
  private atLineStart = true;
  private pendingSpace = false;
  /** Breaks requested by block boundaries (the largest wins). */
  private pendingBreaks = 0;
  /** Breaks from <br> (each one counts). */
  private pendingLineBreaks = 0;
  /** Grows whenever text is written; a link compares it to tell whether it had text. */
  visible = 0;

  private flush(): void {
    const breaks = this.pendingBreaks + this.pendingLineBreaks;
    if (breaks > 0 && this.started) {
      this.parts.push("\n".repeat(breaks));
      this.atLineStart = true;
    }
    this.pendingBreaks = 0;
    this.pendingLineBreaks = 0;
    if (this.pendingSpace && !this.atLineStart) this.parts.push(" ");
    this.pendingSpace = false;
  }

  /** Ordinary text, whitespace already collapsed to single spaces. */
  text(s: string): void {
    if (s.startsWith(" ")) {
      this.pendingSpace = true;
      s = s.slice(1);
    }
    if (!s) return;
    const trailingSpace = s.endsWith(" ");
    if (trailingSpace) s = s.slice(0, -1);
    this.flush();
    this.parts.push(s);
    this.started = true;
    this.atLineStart = false;
    this.visible += s.length;
    if (trailingSpace) this.pendingSpace = true;
  }

  /** Preformatted text, written as is. */
  preformatted(s: string): void {
    if (!s) return;
    this.flush();
    this.parts.push(s);
    this.started = true;
    this.atLineStart = s.endsWith("\n");
    this.visible += s.replace(/\s/g, "").length;
  }

  space(): void {
    this.pendingSpace = true;
  }

  /**
   * Text that follows what was last written after a space, ahead of any line
   * breaks requested since: a link's target stays next to its text even when
   * the link ends with a <br> or an empty block. A space that ended the
   * link's text is kept after the target, so it does not run into the next
   * word.
   */
  trailer(s: string): void {
    const { pendingBreaks, pendingLineBreaks, pendingSpace } = this;
    this.pendingBreaks = 0;
    this.pendingLineBreaks = 0;
    this.pendingSpace = true;
    this.text(s);
    this.pendingBreaks = pendingBreaks;
    this.pendingLineBreaks = pendingLineBreaks;
    this.pendingSpace = pendingSpace;
  }

  lineBreak(): void {
    this.pendingSpace = false;
    this.pendingLineBreaks++;
  }

  blockBoundary(breaks: number): void {
    this.pendingSpace = false;
    this.pendingBreaks = Math.max(this.pendingBreaks, breaks);
  }

  toString(): string {
    return this.parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  }
}

type ParsedElement = DefaultTreeAdapterTypes.Element;

function isElement(node: DefaultTreeAdapterTypes.Node): node is ParsedElement {
  return "tagName" in node;
}

/** True for a td/th (at `index` among its siblings) that follows another cell in the same row. */
function followsCell(cell: ParsedElement, index: number): boolean {
  const siblings = cell.parentNode?.childNodes ?? [];
  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (isElement(sibling)) return sibling.tagName === "td" || sibling.tagName === "th";
  }
  return false;
}

/*
 * Limits past which HTML is not rendered at all. Real email stays far inside
 * each of them; markup past them is hostile or broken, and tree construction
 * on it can cost seconds to minutes on a server that handles one request at a
 * time. Rendering part of such a message would be no more trustworthy than
 * rendering none, so it is not shown (see HTML_NOT_SHOWN).
 */

/**
 * Deepest element nesting, counting template contents as nested in their
 * template (parse5 recurses once per open template at the end of input).
 * Blink flattens the DOM at this depth.
 */
const MAX_NESTING = 512;

/**
 * Most attributes on one tag. The tokenizer checks each new attribute against
 * the tag's earlier ones, so its cost grows with the square of the count.
 */
const MAX_ATTRIBUTES = 1000;

/**
 * Most work for one message, in the units parseMail charges: WORK_PER_CHAR
 * for each character of input (the attribute scan, tokenizer and walk each
 * pass over every one), the tokenizer's attribute comparisons, and the tree
 * adapter's charges. On a sample of real
 * mail the most any message used was about 2 million (a 478 KB HTML part);
 * this allows about 4 MB of markup as dense as that, well past real mail
 * (Gmail itself clips messages over 102 KB), and keeps a hostile message to
 * under a second.
 */
const MAX_PARSE_WORK = 20_000_000;

/** Work charged per input character; see MAX_PARSE_WORK. */
const WORK_PER_CHAR = 4;

/** What a reader is shown in place of HTML that is past those limits. */
const HTML_NOT_SHOWN = "[HTML not shown: this message's HTML is far outside what real email contains]";

class ParseLimitReached extends Error {}

/**
 * The attributes the tokenizer would collect per tag, counted from every
 * `<` followed by a letter (or `</` and a letter), whether or not the
 * tokenizer reaches it as a tag (it might be inside a comment, raw text or
 * a quoted value). Starting everywhere means no misreading of comments, raw
 * text or quotes earlier in the input can hide a tag from the count; it can
 * only overcount. An overcount trips MAX_ATTRIBUTES early and also feeds the
 * pair sum charged to the work budget, so starts inside one unterminated tag
 * can exhaust the budget on small hostile input; real mail stays far below
 * either limit. Each start is
 * followed through the tokenizer's tag states (tag name, attribute name and
 * value, quoted or not, self-closing) to the `>` that ends the tag. All
 * starts are evaluated together in one backward pass: `next[s]` holds the
 * number of attributes the tokenizer would still begin from state `s` at the
 * following position, so the pass is linear in the input.
 *
 * Returns the most on any one tag, and the sum over tags of k(k-1)/2 for k
 * attributes: the comparisons the tokenizer makes checking each attribute
 * against the tag's earlier ones.
 */
function tagAttributeStats(html: string): { max: number; pairs: number } {
  const TAG_NAME = 0, BEFORE_NAME = 1, NAME = 2, AFTER_NAME = 3, BEFORE_VALUE = 4,
    DOUBLE_QUOTED = 5, SINGLE_QUOTED = 6, UNQUOTED = 7, AFTER_QUOTED = 8, SELF_CLOSING = 9;
  let after2 = new Array<number>(10).fill(0);
  let after1 = new Array<number>(10).fill(0);
  let here = new Array<number>(10).fill(0);
  const isAlpha = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  let max = 0;
  let pairs = 0;
  const count = (k: number) => {
    max = Math.max(max, k);
    pairs += (k * (k - 1)) / 2;
  };
  for (let i = html.length - 1; i >= 0; i--) {
    const c = html.charCodeAt(i);
    const x = after1;
    const ws = c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
    const slash = c === 47, gt = c === 62, eq = c === 61, dq = c === 34, sq = c === 39;
    here[TAG_NAME] = ws ? x[BEFORE_NAME] : slash ? x[SELF_CLOSING] : gt ? 0 : x[TAG_NAME];
    here[NAME] = ws ? x[AFTER_NAME] : slash ? x[SELF_CLOSING] : gt ? 0 : eq ? x[BEFORE_VALUE] : x[NAME];
    here[AFTER_NAME] = ws ? x[AFTER_NAME] : slash ? x[SELF_CLOSING] : gt ? 0 : eq ? x[BEFORE_VALUE] : 1 + x[NAME];
    here[BEFORE_NAME] = ws ? x[BEFORE_NAME] : slash ? x[SELF_CLOSING] : gt ? 0 : 1 + x[NAME];
    here[BEFORE_VALUE] = ws ? x[BEFORE_VALUE] : dq ? x[DOUBLE_QUOTED] : sq ? x[SINGLE_QUOTED] : gt ? 0 : x[UNQUOTED];
    here[DOUBLE_QUOTED] = dq ? x[AFTER_QUOTED] : x[DOUBLE_QUOTED];
    here[SINGLE_QUOTED] = sq ? x[AFTER_QUOTED] : x[SINGLE_QUOTED];
    here[UNQUOTED] = ws ? x[BEFORE_NAME] : gt ? 0 : x[UNQUOTED];
    here[AFTER_QUOTED] = ws ? x[BEFORE_NAME] : slash ? x[SELF_CLOSING] : gt ? 0 : 1 + x[NAME];
    here[SELF_CLOSING] = gt ? 0 : ws ? x[BEFORE_NAME] : slash ? x[SELF_CLOSING] : 1 + x[NAME];
    if (c === 60) {
      // `<` + letter: the tokenizer enters the tag name at the letter (after1);
      // `</` + letter: one position further (after2).
      const d = html.charCodeAt(i + 1);
      if (isAlpha(d)) count(after1[TAG_NAME]);
      else if (d === 47 && isAlpha(html.charCodeAt(i + 2))) count(after2[TAG_NAME]);
    }
    [after2, after1, here] = [after1, here, after2];
  }
  return { max, pairs };
}

/**
 * Parses `html` as a document with scripting off, as a mail client renders it,
 * within the limits above; undefined when it is past any of them or the parse
 * fails. The input's length and the tokenizer's attribute comparisons (from
 * tagAttributeStats) are charged to a work budget first. Most tree
 * construction work goes through the tree adapter, so the adapter
 * charges every call to the same budget: one unit per call (the open
 * element stack's scope checks call getNamespaceURI once per element they
 * pass), plus the length of the child list that an insertBefore,
 * insertTextBefore or detachNode searches and splices, plus the ancestors
 * walked to check nesting. adoptAttributes, which merges the attributes of a
 * repeated <html> or <body> tag into the first, does nothing: nothing reads
 * attributes of html or body, and merging them is quadratic.
 *
 * Not charged: the parser's own scans of its open-element stack outside the
 * adapter, e.g. reconstructing active formatting elements before each
 * character token. Text under a formatting element several hundred levels
 * deep therefore costs more per unit than the budget assumes (a few seconds
 * at the budget's edge on hostile input); real mail nests far shallower.
 */
function parseMail(html: string): { doc?: DefaultTreeAdapterTypes.Document; work: number } {
  let work = 0;
  const charge = (units: number) => {
    work += units;
    if (work > MAX_PARSE_WORK) throw new ParseLimitReached();
  };
  const templateOf = new WeakMap<DefaultTreeAdapterTypes.DocumentFragment, DefaultTreeAdapterTypes.Template>();
  const checkNesting = (parent: DefaultTreeAdapterTypes.ParentNode, node: DefaultTreeAdapterTypes.ChildNode) => {
    if (!isElement(node)) return;
    let depth = 0;
    for (let n: DefaultTreeAdapterTypes.ParentNode | null | undefined = parent; n && depth < MAX_NESTING; depth++) {
      n = "parentNode" in n ? n.parentNode : templateOf.get(n as DefaultTreeAdapterTypes.DocumentFragment);
    }
    charge(depth);
    if (depth >= MAX_NESTING) throw new ParseLimitReached();
  };
  const charged = {} as Record<string, (...args: unknown[]) => unknown>;
  for (const [name, fn] of Object.entries(defaultTreeAdapter)) {
    charged[name] = (...args: unknown[]) => {
      charge(1);
      return (fn as (...a: unknown[]) => unknown).apply(defaultTreeAdapter, args);
    };
  }
  const base = charged as unknown as TreeAdapter<DefaultTreeAdapterMap>;
  const treeAdapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...base,
    setTemplateContent: (template, content) => {
      templateOf.set(content, template);
      base.setTemplateContent(template, content);
    },
    appendChild: (parent, node) => {
      checkNesting(parent, node);
      base.appendChild(parent, node);
    },
    insertBefore: (parent, node, reference) => {
      checkNesting(parent, node);
      charge(parent.childNodes.length);
      base.insertBefore(parent, node, reference);
    },
    insertTextBefore: (parent, text, reference) => {
      charge(parent.childNodes.length);
      base.insertTextBefore(parent, text, reference);
    },
    detachNode: (node) => {
      charge(node.parentNode?.childNodes.length ?? 0);
      base.detachNode(node);
    },
    // The list of active formatting elements compares attribute lists it gets here.
    getAttrList: (element) => {
      charge(element.attrs.length);
      return base.getAttrList(element);
    },
    adoptAttributes: () => charge(1),
  };
  try {
    charge(html.length * WORK_PER_CHAR);
    const attributes = tagAttributeStats(html);
    if (attributes.max > MAX_ATTRIBUTES) return { work };
    charge(attributes.pairs);
    return { doc: parse(html, { treeAdapter, scriptingEnabled: false }), work };
  } catch {
    return { work };
  }
}

/** walkToText, or undefined if it fails. */
function renderDoc(doc: DefaultTreeAdapterTypes.Document, linkTargets: boolean): string | undefined {
  try {
    return walkToText(doc, linkTargets);
  } catch {
    return undefined;
  }
}

/**
 * The document's base URL, as a browser sets it: the href of the first HTML
 * <base> element that has one, in tree order wherever it sits, if that href
 * is an absolute URL. A message has no URL of its own, so a relative or
 * unparsable first href leaves no base, and later <base> elements never count.
 * Template contents are not in the tree, so a <base> there is skipped too.
 */
function documentBase(doc: DefaultTreeAdapterTypes.Document): URL | undefined {
  const stack: DefaultTreeAdapterTypes.Node[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node) && node.tagName === "base" && node.namespaceURI === parse5Html.NS.HTML) {
      const href = node.attrs.find((a) => a.name === "href" && !a.namespace);
      if (href) {
        try {
          return new URL(href.value);
        } catch {
          return undefined;
        }
      }
    }
    if (!("childNodes" in node)) continue;
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return undefined;
}

/** A link's href: the plain `href` (what HTML and SVG 2 follow), else SVG's `xlink:href`. */
function hrefOf(element: ParsedElement): string | undefined {
  return (element.attrs.find((a) => a.name === "href" && !a.namespace) ?? element.attrs.find((a) => a.name === "href"))?.value;
}

/**
 * Renders a document parsed by parseMail (parse5, the WHATWG parsing algorithm
 * a browser uses) as plain text by walking the tree. The body is parsed as a full
 * document because a MIME text/html part is one: its own head (title, styles)
 * stays out of the body, and markup outside <html> lands where a browser puts
 * it. Comments and HIDDEN_ELEMENTS are skipped. Images contribute nothing:
 * their alt text is mostly logos and spacers, and counting it would tilt the
 * text/plain-versus-HTML comparison in bestBodyText.
 *
 * With `linkTargets`, each link (`<a>`, or an image-map `<area>` with its
 * alt text as the link text) with a target from linkTarget (every non-empty
 * href has one, and an empty href under a <base> does too) is followed by
 * ` <target>`, or is just `<target>` when it has no text, however its text
 * reads: the href is where the link goes, and link text can imitate any URL.
 *
 * The walk is iterative, so deep markup cannot overflow the stack.
 */
function walkToText(doc: DefaultTreeAdapterTypes.Document, linkTargets: boolean): string {
  const sink = new TextSink();
  const base = linkTargets ? documentBase(doc) : undefined;
  type Step = { node: DefaultTreeAdapterTypes.Node; index: number; exit?: () => void };
  const stack: Step[] = [{ node: doc, index: 0 }];
  let preDepth = 0;
  while (stack.length > 0) {
    const step = stack.pop()!;
    if (step.exit) {
      step.exit();
      continue;
    }
    const node = step.node;
    if (node.nodeName === "#text") {
      const value = (node as DefaultTreeAdapterTypes.TextNode).value;
      if (preDepth > 0) sink.preformatted(value.replace(/\xA0/g, " "));
      else sink.text(value.replace(/[\t\n\f\r \xA0]+/g, " "));
      continue;
    }
    if (!("childNodes" in node)) continue; // comments and doctypes
    const exits: Array<() => void> = [];
    if (isElement(node)) {
      const tag = node.tagName;
      if (HIDDEN_ELEMENTS.has(tag)) continue;
      if (tag === "br") {
        sink.lineBreak();
        continue;
      }
      const href = tag === "a" || tag === "area" ? hrefOf(node) : undefined;
      const target = linkTargets && href !== undefined ? linkTarget(href, base) : undefined;
      if (tag === "area") {
        const alt = (node.attrs.find((a) => a.name === "alt")?.value ?? "").replace(/[\t\n\f\r \xA0]+/g, " ").trim();
        if (target !== undefined && alt) {
          sink.text(` ${alt}`);
          sink.trailer(target);
          sink.space();
        } else if (target !== undefined) {
          sink.text(` ${target} `);
        }
        continue;
      }
      if (BLOCK_ELEMENTS.has(tag)) {
        const breaks = tag === "p" ? 2 : 1;
        sink.blockBoundary(breaks);
        exits.push(() => sink.blockBoundary(breaks));
      }
      if ((tag === "td" || tag === "th") && followsCell(node, step.index)) sink.space();
      if (PREFORMATTED_ELEMENTS.has(tag)) {
        preDepth++;
        exits.push(() => preDepth--);
      }
      if (target !== undefined) {
        const visibleBefore = sink.visible;
        exits.push(() => {
          if (sink.visible > visibleBefore) sink.trailer(target);
          else sink.text(` ${target} `);
        });
      }
    }
    if (exits.length) stack.push({ node, index: step.index, exit: () => exits.reverse().forEach((f) => f()) });
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], index: i });
  }
  return sink.toString();
}

/**
 * HTML -> plain text for the reader of a message (the model): link targets
 * after every link, or HTML_NOT_SHOWN for HTML past the parse limits; capped
 * (with a note) so a huge HTML email can't blow past response size limits.
 */
export function htmlToText(html: string, maxLength = DEFAULT_BODY_TEXT_MAX_LENGTH): string {
  return readerText(parseMail(html).doc, maxLength);
}

/** The reader's text for a parseMail result: the walk with link targets, or HTML_NOT_SHOWN. */
function readerText(doc: DefaultTreeAdapterTypes.Document | undefined, maxLength: number): string {
  return capTextLength((doc && renderDoc(doc, true)) ?? HTML_NOT_SHOWN, maxLength);
}

/**
 * HTML -> plain text for mail being sent (a derived text/plain alternative,
 * a signature): the text as written, without the link targets htmlToText
 * adds for the reader, uncapped, and empty (never a note) for HTML past the
 * parse limits.
 */
export function htmlToOutgoingText(html: string): string {
  const { doc } = parseMail(html);
  return (doc && renderDoc(doc, false)) ?? "";
}

/**
 * Characters that carry no content but are not stripped by String#trim():
 * zero-width space/non-joiner/joiner, word joiner, combining grapheme joiner,
 * Mongolian vowel separator, soft hyphen. Newsletter platforms pad with these.
 */
const BLANK_CHARS = /[\s\u200B-\u200D\u2060\u034F\u180E\u00AD]/gu;

/**
 * URLs and addresses as they appear in the text: `<…>`-delimited targets, the
 * form plain-text mail uses, and bare URLs limited to URL characters (RFC 3986) so a
 * URL that runs straight into unspaced text, as in CJK, does not swallow it.
 */
const URL_TOKENS = /<[^\s<>]+>|(?:https?:\/\/|mailto:)[\w\-.~:/?#[\]@!$&'()*+,;=%]+/gi;

/**
 * Visible prose length: what remains after removing URLs and blank or
 * zero-width characters. URLs are excluded so that long tracking links in the
 * HTML (or a long "view online" URL in a stub) do not decide the comparison.
 */
function proseLength(text: string): number {
  return text.replace(URL_TOKENS, "").replace(BLANK_CHARS, "").length;
}

/**
 * A text/plain part with under 1/STUB_RATIO of the HTML's prose is treated as
 * a stub ("best viewed in HTML", "view in browser") rather than an
 * alternative rendering. A full alternative carries most of its HTML's
 * prose; on sampled real mail none fell below 1/3. Below it are pointers to
 * the HTML with a footer, and teasers that render only part of a much
 * longer HTML message; in both, the HTML holds content the text/plain part
 * lacks. A stub with a long footer can stay above 1/3 and is returned as the
 * body; a lower ratio would start replacing full alternatives with flattened
 * HTML.
 */
const STUB_RATIO = 3;

/**
 * Pick the best readable body for a message.
 *
 * Prefers text/plain, but only when it actually has content and is a real
 * rendering of the message. An HTML-only sender still emits a text/plain
 * part, either whitespace or zero-width padding, or a one-line stub pointing
 * at the HTML; returning it would discard the actual message body. Content is
 * compared structurally (prose length) rather than by matching stub phrases,
 * which vary by sender and language.
 *
 * Both branches go through the same cap.
 */
export function bestBodyText(
  body: { text: string; html: string },
  maxLength = DEFAULT_BODY_TEXT_MAX_LENGTH,
): string {
  const text = body.text.trim();
  const hasText = text.replace(BLANK_CHARS, "") !== "";
  if (!body.html) return hasText ? capTextLength(text, maxLength) : "";
  // The HTML's prose cannot exceed its length (entities only shorten text), so
  // a text/plain part that wins against that needs no parse at all.
  if (hasText && proseLength(text) * STUB_RATIO >= body.html.length) return capTextLength(text, maxLength);
  const { doc } = parseMail(body.html);
  if (hasText) {
    // Measured without the link targets htmlToText adds, so the number of
    // links cannot decide which part is returned.
    const prose = doc && renderDoc(doc, false);
    if (prose === undefined || proseLength(text) * STUB_RATIO >= proseLength(prose)) return capTextLength(text, maxLength);
  }
  return readerText(doc, maxLength);
}

export function formatMessage(msg: gmail_v1.Schema$Message): Record<string, unknown> {
  const headers = msg.payload?.headers;
  const body = extractBody(msg.payload);
  const attachments = extractAttachments(msg.payload);
  const rfc822MessageId = getHeader(headers, "message-id");
  return {
    id: msg.id,
    threadId: msg.threadId,
    // The RFC822 Message-ID header, grouped with the other identifiers. Unlike the Gmail
    // `id` above it is stable across mailboxes, so callers use it to cite a message
    // (`rfc822msgid:` searches) and to thread replies by hand. Omitted rather than returned
    // empty when absent, as some drafts have no Message-ID until they are sent.
    ...(rfc822MessageId ? { rfc822MessageId } : {}),
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    subject: getHeader(headers, "subject"),
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to"),
    cc: getHeader(headers, "cc"),
    date: getHeader(headers, "date"),
    body: bestBodyText(body),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
