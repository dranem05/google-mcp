import { describe, expect, it } from "vitest";
import {
  buildRawEmail,
  buildReplyHeaders,
  capTextLength,
  formatMessage,
  htmlToText,
  parseAddressList,
  type OriginalMessageHeaders,
} from "./email.js";

describe("buildRawEmail header hardening", () => {
  it("neutralizes a CRLF header-injection attempt in the subject", () => {
    const raw = buildRawEmail({
      to: ["victim@example.com"],
      subject: "Hi\r\nBcc: attacker@evil.com\r\nX-Injected: 1",
      body: "hello",
    });
    const lines = raw.split("\r\n");

    // The injected "headers" must not become real header lines of their own.
    expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
    expect(lines.some((l) => /^X-Injected:/i.test(l))).toBe(false);

    // The injected text should still be present, but folded into the Subject line.
    const subjectLine = lines.find((l) => l.startsWith("Subject:"));
    expect(subjectLine).toBeDefined();
    expect(subjectLine).toContain("Bcc: attacker@evil.com");
  });

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "Hello 🎉 World", body: "hi" });
    const subjectLine = raw.split("\r\n").find((l) => l.startsWith("Subject:"));
    expect(subjectLine).toBeDefined();

    const match = /^Subject: =\?UTF-8\?B\?(.+)\?=$/.exec(subjectLine!);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1], "base64").toString("utf-8");
    expect(decoded).toBe("Hello 🎉 World");
  });

  it("leaves a plain ASCII subject unencoded", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "Plain subject", body: "hi" });
    expect(raw.split("\r\n")).toContain("Subject: Plain subject");
  });

  it("never RFC 2047-encodes address headers, keeping the addr-spec literal", () => {
    const raw = buildRawEmail({
      to: ["José García <jose@example.com>"],
      cc: ["Zoë <zoe@example.com>"],
      subject: "test",
      body: "hi",
    });
    const lines = raw.split("\r\n");
    const toLine = lines.find((l) => l.startsWith("To:"));
    const ccLine = lines.find((l) => l.startsWith("Cc:"));
    // Encoding the whole value would swallow the email address into a
    // base64 blob (invalid per RFC 5322 — encoded-words can't appear in
    // an addr-spec). The address must stay literal and readable.
    expect(toLine).toContain("<jose@example.com>");
    expect(toLine).not.toContain("=?UTF-8?B?");
    expect(ccLine).toContain("<zoe@example.com>");
    expect(ccLine).not.toContain("=?UTF-8?B?");
  });

  it("still strips CRLF injection from address headers", () => {
    const raw = buildRawEmail({
      to: ["a@b.com\r\nX-Evil: 1"],
      subject: "test",
      body: "hi",
    });
    expect(raw.split("\r\n").some((l) => /^X-Evil:/i.test(l))).toBe(false);
  });

  it("base64-encodes a long-line body so no raw line can exceed RFC 5322's 998-octet limit", () => {
    const longLine = "a".repeat(2000);
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "test", body: longLine });

    expect(raw).toContain("Content-Transfer-Encoding: base64");
    for (const line of raw.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(998);
    }

    const headerEnd = raw.indexOf("\r\n\r\n");
    const bodyPart = raw.slice(headerEnd + 4);
    const decodedBody = Buffer.from(bodyPart.replace(/\r\n/g, ""), "base64").toString("utf-8");
    expect(decodedBody).toBe(longLine);
  });

  it("declares MIME-Version: 1.0 on the plain-text path (required when using Content-Transfer-Encoding)", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "test", body: "hello" });
    const headerEnd = raw.indexOf("\r\n\r\n");
    const headerLines = raw.slice(0, headerEnd).split("\r\n");
    expect(headerLines).toContain("MIME-Version: 1.0");
    expect(headerLines).toContain("Content-Transfer-Encoding: base64");
  });

  it("base64-encodes both parts of a multipart/alternative message", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "test",
      body: "plain body",
      htmlBody: "<p>html body</p>",
      mimeType: "multipart/alternative",
    });
    const encodedCount = (raw.match(/Content-Transfer-Encoding: base64/g) || []).length;
    expect(encodedCount).toBe(2);
  });
});

describe("buildRawEmail attachments (multipart/mixed)", () => {
  const contentBase64 = Buffer.from("file bytes").toString("base64");

  it("wraps the body and each attachment in a multipart/mixed container", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "with file",
      body: "see attached",
      attachments: [{ filename: "notes.txt", mimeType: "text/plain", contentBase64 }],
    });
    const headerEnd = raw.indexOf("\r\n\r\n");
    const topHeaders = raw.slice(0, headerEnd);
    const mixed = /Content-Type: multipart\/mixed; boundary="(mixed_[^"]+)"/.exec(topHeaders);
    expect(mixed).not.toBeNull();
    const boundary = mixed![1];
    // Opening delimiter for both parts, plus the closing delimiter.
    expect((raw.match(new RegExp(`--${boundary}(?!--)`, "g")) || []).length).toBe(2);
    expect(raw).toContain(`--${boundary}--`);
    expect(raw).toContain('Content-Disposition: attachment; filename="notes.txt"');
    // The attachment's bytes are present, base64-encoded.
    expect(raw).toContain(contentBase64);
  });

  it("nests a multipart/alternative body inside the mixed container", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "rich + file",
      body: "plain",
      htmlBody: "<p>rich</p>",
      mimeType: "multipart/alternative",
      attachments: [{ filename: "a.bin", mimeType: "application/octet-stream", contentBase64 }],
    });
    expect(raw).toContain("Content-Type: multipart/mixed;");
    expect(raw).toContain("Content-Type: multipart/alternative;");
  });

  it("strips CR/LF and quotes from an attachment filename to prevent header injection", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "evil",
      body: "x",
      attachments: [{ filename: 'a"\r\nX-Evil: yes.txt', mimeType: "text/plain", contentBase64 }],
    });
    expect(raw.split("\r\n").some((l) => /^X-Evil:/i.test(l))).toBe(false);
  });
});

describe("parseAddressList", () => {
  it("extracts bare addresses, honoring commas inside display names", () => {
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual([
      "jane@x.com",
      "bob@y.com",
    ]);
  });

  it("returns an empty list for an empty header", () => {
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("buildReplyHeaders", () => {
  const original: OriginalMessageHeaders = {
    messageIdHeader: "<msg-2@mail.example.com>",
    references: "<msg-1@mail.example.com>",
    subject: "Project update",
    from: "Alice <alice@example.com>",
    to: "me@example.com, Carol <carol@example.com>",
    cc: "dave@example.com",
  };

  it("replies to the sender, threads via In-Reply-To and an extended References chain", () => {
    const r = buildReplyHeaders(original, { selfEmail: "me@example.com" });
    expect(r.to).toEqual(["alice@example.com"]);
    expect(r.cc).toEqual([]);
    expect(r.inReplyTo).toBe("<msg-2@mail.example.com>");
    expect(r.references).toBe("<msg-1@mail.example.com> <msg-2@mail.example.com>");
    expect(r.subject).toBe("Re: Project update");
  });

  it("reply-all CCs the other recipients but drops self and the sender", () => {
    const r = buildReplyHeaders(original, { replyAll: true, selfEmail: "me@example.com" });
    expect(r.to).toEqual(["alice@example.com"]);
    expect(r.cc).toEqual(["carol@example.com", "dave@example.com"]);
  });

  it("does not double-prefix a subject that already starts with Re:", () => {
    const r = buildReplyHeaders({ ...original, subject: "RE: Project update" });
    expect(r.subject).toBe("RE: Project update");
  });

  it("uses the Message-ID alone as References when the original had none", () => {
    const r = buildReplyHeaders({ ...original, references: "" });
    expect(r.references).toBe("<msg-2@mail.example.com>");
  });
});

describe("htmlToText", () => {
  it("strips tags, scripts, and styles, converts <br> to newlines, and decodes entities", () => {
    const html =
      "<html><head><style>body{color:red}</style></head><body>" +
      "<script>alert(1)</script><p>Hello &amp; welcome</p><br>Line2</body></html>";
    expect(htmlToText(html)).toBe("Hello & welcome\nLine2");
  });

  it("caps output length and appends a truncation note", () => {
    const html = `<p>${"a".repeat(100)}</p>`;
    const text = htmlToText(html, 20);
    expect(text.startsWith("a".repeat(20))).toBe(true);
    expect(text).toContain("truncated");
  });

  it("does not truncate content within the length cap", () => {
    const text = htmlToText("<p>short</p>", 1000);
    expect(text).toBe("short");
  });
});

describe("capTextLength", () => {
  it("returns short text unchanged", () => {
    expect(capTextLength("hello", 100)).toBe("hello");
  });

  it("caps oversized text and appends a truncation note", () => {
    const capped = capTextLength("a".repeat(50), 20);
    expect(capped.startsWith("a".repeat(20))).toBe(true);
    expect(capped).toContain("[truncated: showing 20 of 50 characters]");
  });
});

describe("formatMessage body capping", () => {
  it("caps an oversized plain-text body at 50k chars with a truncation note", () => {
    const bigBody = "x".repeat(60_000);
    const msg = {
      id: "m1",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "big" }],
        body: { data: Buffer.from(bigBody).toString("base64url") },
      },
    };
    const formatted = formatMessage(msg);
    const body = formatted.body as string;
    expect(body.length).toBeLessThan(60_000);
    expect(body.startsWith("x".repeat(50_000))).toBe(true);
    expect(body).toContain("[truncated: showing 50000 of 60000 characters]");
  });

  it("leaves a normal-sized plain-text body untouched", () => {
    const msg = {
      id: "m2",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { data: Buffer.from("short body").toString("base64url") },
      },
    };
    expect(formatMessage(msg).body).toBe("short body");
  });
});
