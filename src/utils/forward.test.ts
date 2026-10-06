import { describe, expect, it } from "vitest";
import { gmail_v1 } from "googleapis";
import {
  buildForwardHeaderBlock,
  buildForwardRawEmail,
  buildForwardSubject,
  checkForwardRawSize,
  deriveMissingBodyPart,
  largestAttachments,
  parseForwardContent,
  selectForwardAttachments,
  type ForwardHeaderFields,
} from "./forward.js";
import { encodeBase64Url, type EmailAttachment, type InlineImagePart } from "./email.js";

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
  // alternative and as an application/ics attachment.
  function calendarPayload(withAttachedCopy: boolean): gmail_v1.Schema$MessagePart {
    const ics = { attachmentId: "att-ics", size: 1907 };
    return {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Jane accepted") } },
            { mimeType: "text/html", body: { data: b64url("<p>Jane accepted</p>") } },
            { mimeType: "text/calendar", filename: "invite.ics", body: ics },
          ],
        },
        ...(withAttachedCopy ? [{ mimeType: "application/ics", filename: "invite.ics", body: ics }] : []),
      ],
    };
  }

  it("forwards a calendar invite's .ics once when it is both a body alternative and an attachment", () => {
    const parsed = parseForwardContent(calendarPayload(true));
    expect(parsed.attachments.map((a) => a.mimeType)).toEqual(["application/ics"]);
  });

  it("keeps a calendar body alternative as the attachment when there is no attached copy", () => {
    const parsed = parseForwardContent(calendarPayload(false));
    expect(parsed.attachments.map((a) => `${a.mimeType} ${a.filename}`)).toEqual(["text/calendar invite.ics"]);
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
  it("passes for a small encoded message", () => {
    const check = checkForwardRawSize(encodeBase64Url("small message"));
    expect(check.ok).toBe(true);
  });

  it("refuses an encoded message over the 25MB limit", () => {
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
