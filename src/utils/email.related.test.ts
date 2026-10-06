import { describe, expect, it } from "vitest";
import { buildRawEmail } from "./email.js";

describe("buildRawEmail multipart/related (inline images)", () => {
  it("sets RFC 2387's required type parameter to the root part's MIME type (multipart/alternative) when both text and html bodies are present", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "s",
      body: "plain",
      htmlBody: '<img src="cid:img1@x">',
      mimeType: "multipart/alternative",
      inlineImages: [{ filename: "logo.png", mimeType: "image/png", contentBase64: Buffer.from("png").toString("base64"), contentId: "<img1@x>" }],
    });
    const relatedLine = raw.split("\r\n").find((l) => l.startsWith("Content-Type: multipart/related"));
    expect(relatedLine).toBeDefined();
    expect(relatedLine).toContain('type="multipart/alternative"');
  });

  it("sets the type parameter to text/html when there's no plain-text alternative", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "s",
      body: "ignored",
      htmlBody: '<img src="cid:img1@x">',
      mimeType: "text/html",
      inlineImages: [{ filename: "logo.png", mimeType: "image/png", contentBase64: Buffer.from("png").toString("base64"), contentId: "<img1@x>" }],
    });
    const relatedLine = raw.split("\r\n").find((l) => l.startsWith("Content-Type: multipart/related"));
    expect(relatedLine).toContain('type="text/html"');
  });

  it("omits the multipart/related wrapper entirely (and so the type parameter) when there are no inline images", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "s", body: "plain", htmlBody: "<p>hi</p>", mimeType: "multipart/alternative" });
    expect(raw).not.toContain("multipart/related");
  });
});
