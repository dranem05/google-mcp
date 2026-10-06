import { describe, expect, it } from "vitest";
import { gmail_v1 } from "googleapis";
import {
  buildForwardHeaderBlock,
  buildForwardRawEmail,
  buildForwardSubject,
  checkForwardRawSize,
  deriveMissingBodyPart,
  estimateForwardSize,
  largestAttachments,
  parseForwardContent,
  selectForwardAttachments,
  type ForwardHeaderFields,
} from "./forward.js";
import { type EmailAttachment, type InlineImagePart } from "./email.js";

const b64url = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

const ORIGINAL_HEADER_FIELDS: ForwardHeaderFields = {
  from: "Jane Doe <jane@example.com>",
  date: "Mon, 1 Jan 2026 10:00:00 -0700",
  subject: "Quarterly update",
  to: "Bob <bob@example.com>",
};

describe("buildForwardSubject", () => {
  it("prefixes a plain subject with Fwd:", () => {
    expect(buildForwardSubject("Quarterly update")).toBe("Fwd: Quarterly update");
  });

  it("does not double-prefix a subject that already starts with Fwd:", () => {
    expect(buildForwardSubject("Fwd: Quarterly update")).toBe("Fwd: Quarterly update");
  });

  it("recognizes Fw: and FW: case-insensitively, and leaves them as-is", () => {
    expect(buildForwardSubject("Fw: Quarterly update")).toBe("Fw: Quarterly update");
    expect(buildForwardSubject("FW: Quarterly update")).toBe("FW: Quarterly update");
    expect(buildForwardSubject("fwd: lowercase")).toBe("fwd: lowercase");
  });
});

describe("buildForwardHeaderBlock", () => {
  it("includes the forwarded-message divider and From/Date/Subject/To in order, omitting Cc when absent", () => {
    const { text } = buildForwardHeaderBlock(ORIGINAL_HEADER_FIELDS);
    const lines = text.split("\n");
    expect(lines[0]).toBe("---------- Forwarded message ---------");
    expect(lines).toEqual([
      "---------- Forwarded message ---------",
      "From: Jane Doe <jane@example.com>",
      "Date: Mon, 1 Jan 2026 10:00:00 -0700",
      "Subject: Quarterly update",
      "To: Bob <bob@example.com>",
    ]);
  });

  it("includes Cc when present", () => {
    const { text } = buildForwardHeaderBlock({ ...ORIGINAL_HEADER_FIELDS, cc: "Carol <carol@example.com>" });
    expect(text).toContain("Cc: Carol <carol@example.com>");
  });

  it("HTML-escapes header field values so an untrusted From/Subject can't inject markup", () => {
    const { html } = buildForwardHeaderBlock({
      ...ORIGINAL_HEADER_FIELDS,
      from: 'Evil <script>alert(1)</script> <evil@example.com>',
      subject: 'Subject with & <b>bold</b> "quotes"',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&quot;quotes&quot;");
  });
});

describe("deriveMissingBodyPart", () => {
  it("derives HTML from text when the original had no HTML part", () => {
    const { html } = deriveMissingBodyPart({ text: "Line one\nLine two", html: "" });
    expect(html).toBe("Line one<br>Line two");
  });

  it("derives text from HTML when the original had no text part", () => {
    const { text } = deriveMissingBodyPart({ text: "", html: "<p>Hello &amp; welcome</p>" });
    expect(text).toBe("Hello & welcome");
  });

  it("leaves both parts untouched when both are present", () => {
    const original = { text: "plain", html: "<p>rich</p>" };
    expect(deriveMissingBodyPart(original)).toEqual(original);
  });

  it("derives a >50k-character text/plain alternative from an HTML-only original without truncating it", () => {
    const big = "<p>" + "x".repeat(60_000) + "</p>";
    const { text } = deriveMissingBodyPart({ text: "", html: big });
    expect(text).toHaveLength(60_000);
    expect(text).not.toContain("[truncated:");
  });
});

describe("parseForwardContent", () => {
  it("extracts text and html from a multipart/alternative original", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Hello plain") } },
        { mimeType: "text/html", body: { data: b64url("<p>Hello html</p>") } },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("Hello plain");
    expect(parsed.html).toBe("<p>Hello html</p>");
    expect(parsed.attachments).toEqual([]);
    expect(parsed.inlineImages).toEqual([]);
  });

  it("extracts a text-only original with no html part", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { data: b64url("Just plain text") },
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("Just plain text");
    expect(parsed.html).toBe("");
  });

  it("extracts a multipart/mixed original with a PDF attachment", () => {
    const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes");
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("see attached") } },
            { mimeType: "text/html", body: { data: b64url("<p>see attached</p>") } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: { attachmentId: "att-1", size: pdfBytes.byteLength },
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("see attached");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: "report.pdf", mimeType: "application/pdf", attachmentId: "att-1" });
    expect(parsed.inlineImages).toEqual([]);
  });

  it("classifies a part with a Content-ID header as an inline image, not a regular attachment", () => {
    const imgBytes = Buffer.from("fake png bytes");
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/related",
      parts: [
        { mimeType: "text/html", body: { data: b64url('<p>Look <img src="cid:img1@example.com"></p>') } },
        {
          mimeType: "image/png",
          filename: "image001.png",
          headers: [{ name: "Content-ID", value: "<img1@example.com>" }],
          body: { data: imgBytes.toString("base64url") },
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.inlineImages).toHaveLength(1);
    expect(parsed.inlineImages[0]).toMatchObject({ filename: "image001.png", contentId: "<img1@example.com>" });
    expect(Buffer.from(parsed.inlineImages[0].contentBase64!, "base64").equals(imgBytes)).toBe(true);
  });

  it("walks nested multipart/mixed > (alternative + related) and finds everything at every depth", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: b64url("plain body") } },
                { mimeType: "text/html", body: { data: b64url('<img src="cid:logo">') } },
              ],
            },
            {
              mimeType: "image/png",
              filename: "logo.png",
              headers: [{ name: "Content-ID", value: "<logo>" }],
              body: { data: Buffer.from("logo bytes").toString("base64url") },
            },
          ],
        },
        {
          mimeType: "application/zip",
          filename: "archive.zip",
          body: { attachmentId: "att-zip", size: 12345 },
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("plain body");
    expect(parsed.html).toContain("cid:logo");
    expect(parsed.inlineImages).toHaveLength(1);
    expect(parsed.inlineImages[0].filename).toBe("logo.png");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("archive.zip");
  });

  // Shape of a Google Calendar RSVP: the same invite.ics as a text/calendar body
  // alternative and as an application/ics attachment. Distinct attachmentIds
  // on the two copies so the dedup assertion below can confirm it's the
  // *attached* copy that survives, not just any one of two identical parts.
  function calendarPayload(withAttachedCopy: boolean): gmail_v1.Schema$MessagePart {
    const bodyAltIcs = { attachmentId: "att-ics-body", size: 1907 };
    const attachedIcs = { attachmentId: "att-ics-attached", size: 1907 };
    return {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Jane accepted") } },
            { mimeType: "text/html", body: { data: b64url("<p>Jane accepted</p>") } },
            { mimeType: "text/calendar", filename: "invite.ics", body: bodyAltIcs },
          ],
        },
        ...(withAttachedCopy ? [{ mimeType: "application/ics", filename: "invite.ics", body: attachedIcs }] : []),
      ],
    };
  }

  it("forwards a calendar invite's .ics once when it is both a body alternative and an attachment, keeping the attached copy", () => {
    const parsed = parseForwardContent(calendarPayload(true));
    expect(parsed.attachments.map((a) => a.mimeType)).toEqual(["application/ics"]);
    expect(parsed.attachments[0].attachmentId).toBe("att-ics-attached");
  });

  it("keeps a calendar body alternative as the attachment when there is no attached copy", () => {
    const parsed = parseForwardContent(calendarPayload(false));
    expect(parsed.attachments.map((a) => `${a.mimeType} ${a.filename}`)).toEqual(["text/calendar invite.ics"]);
  });

  it("decodes a text/plain part using its declared charset rather than assuming UTF-8", () => {
    const latin1Bytes = Buffer.from("Caf\xe9 cr\xe8me", "latin1");
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
      body: { data: latin1Bytes.toString("base64url") },
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("Café crème");
  });

  it("decodes a text/html part using its declared charset rather than assuming UTF-8", () => {
    const latin1Bytes = Buffer.from("<p>Caf\xe9</p>", "latin1");
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/html",
      headers: [{ name: "Content-Type", value: "text/html; charset=ISO-8859-1" }],
      body: { data: latin1Bytes.toString("base64url") },
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.html).toBe("<p>Café</p>");
  });

  it("classifies an inline image only when the HTML actually references its Content-ID via cid:, keeping an unreferenced Content-ID part as a regular attachment", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/related",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>no image here</p>") } },
        {
          mimeType: "image/png",
          filename: "unused.png",
          headers: [{ name: "Content-ID", value: "<unused@example.com>" }],
          body: { attachmentId: "att-unused", size: 10 },
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.inlineImages).toEqual([]);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["unused.png"]);
  });

  it("classifies a part with Content-Disposition: attachment as a regular attachment even when it also carries a Content-ID", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: b64url('<p><img src="cid:part1.123@x"></p>') } },
        {
          mimeType: "application/pdf",
          filename: "contract.pdf",
          headers: [
            { name: "Content-Disposition", value: 'attachment; filename="contract.pdf"' },
            { name: "Content-ID", value: "<part1.123@x>" },
          ],
          body: { attachmentId: "att-pdf", size: 5_000_000 },
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.inlineImages).toEqual([]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("contract.pdf");
    // And it's dropped entirely (not kept as an inline fallback) when
    // regular attachments are excluded.
    const selected = selectForwardAttachments(parsed, false);
    expect(selected.attachments).toEqual([]);
    expect(selected.inlineImages).toEqual([]);
  });

  it("keeps a nameless inline image (Content-ID only, no filename) under a generated filename, still matched to its cid: reference", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/related",
      parts: [
        { mimeType: "text/html", body: { data: b64url('<img src="cid:img1">') } },
        {
          mimeType: "image/png",
          filename: "",
          headers: [{ name: "Content-ID", value: "<img1>" }],
          body: { attachmentId: "att-img1", size: 100 },
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.inlineImages).toHaveLength(1);
    expect(parsed.inlineImages[0].filename).toBe("img1.png");
    expect(parsed.inlineImages[0].contentId).toBe("<img1>");
  });

  it("keeps a nameless non-text leaf (no Content-ID) under a generated attachment-N filename instead of dropping it", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("see attached") } },
        { mimeType: "application/pdf", filename: "", body: { attachmentId: "att-nameless", size: 42 } },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("attachment-1.pdf");
    expect(parsed.attachments[0].attachmentId).toBe("att-nameless");
  });

  it("keeps a nameless text/calendar alternative with no attached copy as invite.ics", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("t") } },
        { mimeType: "text/calendar", filename: "", body: { data: b64url("BEGIN:VCALENDAR"), size: 15 } },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("invite.ics");
  });

  it("keeps a message/rfc822 part as an attachment leaf (named .eml), without merging its inner body into the outer text/html", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Please see the forwarded message below.") } },
        { mimeType: "text/html", body: { data: b64url("<p>Please see the forwarded message below.</p>") } },
        {
          mimeType: "message/rfc822",
          filename: "",
          body: { attachmentId: "att-eml", size: 2048 },
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: b64url("INNER ORIGINAL TEXT") } },
                { mimeType: "text/html", body: { data: b64url("<p>INNER ORIGINAL HTML</p>") } },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("Please see the forwarded message below.");
    expect(parsed.html).toBe("<p>Please see the forwarded message below.</p>");
    expect(parsed.text).not.toContain("INNER ORIGINAL TEXT");
    expect(parsed.html).not.toContain("INNER ORIGINAL HTML");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: "forwarded-message.eml", mimeType: "message/rfc822", attachmentId: "att-eml" });
    expect(parsed.warnings).toEqual([]);
  });

  it("treats message/delivery-status as an attachment, not body text", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/report",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Delivery failed.") } },
        { mimeType: "message/delivery-status", body: { data: b64url("Status: 5.1.1") } },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.text).toBe("Delivery failed.");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("delivery-status.txt");
  });

  it("warns rather than silently dropping an rfc822 part with no attachmentId and no inline data", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("hi") } },
        {
          mimeType: "message/rfc822",
          filename: "",
          body: { size: 0 },
          parts: [{ mimeType: "text/plain", body: { data: b64url("inner, unreachable") } }],
        },
      ],
    };
    const parsed = parseForwardContent(payload);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.text).not.toContain("inner, unreachable");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/message\/rfc822.*no attachment data/);
  });
});

describe("selectForwardAttachments", () => {
  const parsed = {
    text: "",
    html: "",
    inlineImages: [{ filename: "inline.png", mimeType: "image/png", size: 10, contentId: "<x>" }],
    attachments: [{ filename: "file.pdf", mimeType: "application/pdf", size: 20 }],
  };

  it("keeps attachments when includeAttachments is true", () => {
    const { attachments, inlineImages } = selectForwardAttachments(parsed, true);
    expect(attachments).toHaveLength(1);
    expect(inlineImages).toHaveLength(1);
  });

  it("drops regular attachments but keeps inline images when includeAttachments is false", () => {
    const { attachments, inlineImages } = selectForwardAttachments(parsed, false);
    expect(attachments).toEqual([]);
    expect(inlineImages).toHaveLength(1);
    expect(inlineImages[0].filename).toBe("inline.png");
  });
});

describe("buildForwardRawEmail", () => {
  const baseOpts = {
    to: ["bob@example.com"],
    originalSubject: "Quarterly update",
    originalHeaderFields: ORIGINAL_HEADER_FIELDS,
    originalBody: { text: "Original text body", html: "<p>Original html body</p>" },
    inlineImages: [] as InlineImagePart[],
    attachments: [] as EmailAttachment[],
  };

  it("sets the Fwd: subject and includes both the note and the forwarded header block", () => {
    const raw = buildForwardRawEmail({ ...baseOpts, note: "FYI, see below" });
    const subjectLine = raw.split("\r\n").find((l) => l.startsWith("Subject:"));
    expect(subjectLine).toBe("Subject: Fwd: Quarterly update");

    // Body content is base64-encoded, so decode the text/plain part rather
    // than searching the raw (still-encoded) bytes.
    const textPartMatch = /Content-Type: text\/plain[^]*?Content-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/.exec(raw);
    expect(textPartMatch).not.toBeNull();
    const decoded = Buffer.from(textPartMatch![1].replace(/\r\n/g, ""), "base64").toString("utf-8");
    expect(decoded).toContain("FYI, see below");
    expect(decoded).toContain("---------- Forwarded message ---------");
    expect(decoded).toContain("Original text body");
  });

  it("preserves the original HTML verbatim (not a text->HTML conversion) in the html part", () => {
    const raw = buildForwardRawEmail({ ...baseOpts, originalBody: { text: "plain", html: "<table><tr><td>cell</td></tr></table>" } });
    // Pull out the base64 html part and decode it.
    const htmlPartMatch = /Content-Type: text\/html[^]*?Content-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/.exec(raw);
    expect(htmlPartMatch).not.toBeNull();
    const decoded = Buffer.from(htmlPartMatch![1].replace(/\r\n/g, ""), "base64").toString("utf-8");
    expect(decoded).toContain("<table><tr><td>cell</td></tr></table>");
  });

  it("keeps a PDF attachment's filename, mime type, and bytes intact", () => {
    const pdfBase64 = Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64");
    const raw = buildForwardRawEmail({
      ...baseOpts,
      attachments: [{ filename: "report.pdf", mimeType: "application/pdf", contentBase64: pdfBase64 }],
    });
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(raw).toContain("Content-Type: application/pdf");
    expect(raw).toContain(pdfBase64);
  });

  it("keeps an inline cid: image in multipart/related with its Content-ID header", () => {
    const imgBase64 = Buffer.from("fake png bytes").toString("base64");
    const raw = buildForwardRawEmail({
      ...baseOpts,
      originalBody: { text: "plain", html: '<img src="cid:img1@example.com">' },
      inlineImages: [{ filename: "image001.png", mimeType: "image/png", contentBase64: imgBase64, contentId: "<img1@example.com>" }],
    });
    expect(raw).toContain("Content-Type: multipart/related;");
    expect(raw).toContain("Content-ID: <img1@example.com>");
    expect(raw).toContain("Content-Disposition: inline");
    expect(raw).toContain(imgBase64);

    const htmlPartMatch = /Content-Type: text\/html[^]*?Content-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/.exec(raw);
    expect(htmlPartMatch).not.toBeNull();
    const decodedHtml = Buffer.from(htmlPartMatch![1].replace(/\r\n/g, ""), "base64").toString("utf-8");
    expect(decodedHtml).toContain("cid:img1@example.com");
  });

  it("drops a regular attachment but keeps the inline image when attachments list is empty (includeAttachments:false path)", () => {
    const imgBase64 = Buffer.from("fake png bytes").toString("base64");
    const raw = buildForwardRawEmail({
      ...baseOpts,
      inlineImages: [{ filename: "image001.png", mimeType: "image/png", contentBase64: imgBase64, contentId: "<img1@example.com>" }],
      attachments: [], // caller already filtered these out via selectForwardAttachments
    });
    expect(raw).toContain("Content-ID: <img1@example.com>");
    expect(raw).not.toContain("Content-Disposition: attachment");
  });

  it("sets In-Reply-To and References from the original message for threading", () => {
    const raw = buildForwardRawEmail({
      ...baseOpts,
      inReplyTo: "<msg-1@mail.example.com>",
      references: "<msg-0@mail.example.com> <msg-1@mail.example.com>",
    });
    const lines = raw.split("\r\n");
    expect(lines).toContain("In-Reply-To: <msg-1@mail.example.com>");
    expect(lines).toContain("References: <msg-0@mail.example.com> <msg-1@mail.example.com>");
  });

  it("derives a missing HTML part minimally when the original was text-only", () => {
    const raw = buildForwardRawEmail({ ...baseOpts, originalBody: { text: "Plain only\nSecond line", html: "" } });
    const htmlPartMatch = /Content-Type: text\/html[^]*?Content-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/.exec(raw);
    expect(htmlPartMatch).not.toBeNull();
    const decoded = Buffer.from(htmlPartMatch![1].replace(/\r\n/g, ""), "base64").toString("utf-8");
    expect(decoded).toContain("Plain only<br>Second line");
  });
});

describe("checkForwardRawSize", () => {
  it("passes for a small raw MIME message", () => {
    const check = checkForwardRawSize("small message");
    expect(check.ok).toBe(true);
  });

  it("refuses a raw MIME message over the 25MB limit", () => {
    const big = "a".repeat(26 * 1024 * 1024);
    const check = checkForwardRawSize(big);
    expect(check.ok).toBe(false);
    expect(check.totalBytes).toBeGreaterThan(check.limitBytes);
  });

  it("respects a custom limit", () => {
    const check = checkForwardRawSize("0123456789", 5);
    expect(check.ok).toBe(false);
    expect(check.totalBytes).toBe(10);
    expect(check.limitBytes).toBe(5);
  });

  it("checks the MIME size, not the larger base64url-encoded transport size — a message between the two thresholds is not refused", () => {
    // 19 MiB of raw MIME text encodes to ~25.3 MiB in base64url, which the
    // old (wrong) encoded-size check would have refused.
    const raw = "a".repeat(19 * 1024 * 1024);
    const check = checkForwardRawSize(raw);
    expect(check.ok).toBe(true);
  });
});

describe("estimateForwardSize", () => {
  it("passes when the estimated size (parts scaled 4/3 for base64, plus body bytes) is under the limit", () => {
    const est = estimateForwardSize([{ size: 1000 }, { size: 2000 }], 500);
    expect(est.ok).toBe(true);
    expect(est.estimatedBytes).toBe(Math.ceil(1000 * (4 / 3)) + Math.ceil(2000 * (4 / 3)) + 500);
  });

  it("refuses before any bytes are fetched when selected parts' declared sizes alone already exceed the limit", () => {
    const est = estimateForwardSize([{ size: 20 * 1024 * 1024 }], 0, 25 * 1024 * 1024);
    expect(est.ok).toBe(false);
    expect(est.estimatedBytes).toBeGreaterThan(est.limitBytes);
  });

  it("respects a custom limit", () => {
    const est = estimateForwardSize([{ size: 10 }], 0, 5);
    expect(est.ok).toBe(false);
    expect(est.limitBytes).toBe(5);
  });
});

describe("largestAttachments", () => {
  it("sorts descending by size and caps at the limit", () => {
    const items = [
      { filename: "a", size: 10 },
      { filename: "b", size: 100 },
      { filename: "c", size: 50 },
    ];
    expect(largestAttachments(items, 2)).toEqual([
      { filename: "b", size: 100 },
      { filename: "c", size: 50 },
    ]);
  });

  it("does not mutate the input array", () => {
    const items = [{ filename: "a", size: 1 }, { filename: "b", size: 2 }];
    const copy = [...items];
    largestAttachments(items);
    expect(items).toEqual(copy);
  });
});
