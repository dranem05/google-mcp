import { describe, expect, it } from "vitest";
import {
  bestBodyText,
  buildRawEmail,
  buildReplyHeaders,
  capTextLength,
  formatMessage,
  htmlToOutgoingText,
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

  it("omits the From header when opts.from is not supplied (unchanged default behavior)", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "test", body: "hi" });
    expect(raw.split("\r\n").some((l) => /^From:/i.test(l))).toBe(false);
  });

  it("sets the From header verbatim when opts.from is supplied", () => {
    const raw = buildRawEmail({
      to: ["a@b.com"],
      subject: "test",
      body: "hi",
      from: "Team Alias <alias@example.com>",
    });
    const fromLine = raw.split("\r\n").find((l) => l.startsWith("From:"));
    expect(fromLine).toBe("From: Team Alias <alias@example.com>");
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

  it("reply-all drops every self address when selfEmail is a list", () => {
    const r = buildReplyHeaders(original, { replyAll: true, selfEmail: ["other@example.com", "ME@example.com"] });
    expect(r.cc).toEqual(["carol@example.com", "dave@example.com"]);
    const r2 = buildReplyHeaders(
      { ...original, cc: "alias@example.com, dave@example.com" },
      { replyAll: true, selfEmail: ["me@example.com", "alias@example.com"] }
    );
    expect(r2.cc).toEqual(["carol@example.com", "dave@example.com"]);
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
    expect(htmlToText(html)).toBe("Hello & welcome\n\nLine2");
  });

  it("leaves out the head, comments and content that is never shown", () => {
    const html =
      "<html><head><title>Weekly update</title><meta name=x content=y></head><body>" +
      "<!-- tracking -->Hi<template><p>hidden</p></template>" +
      "<noframes><p>No frames</p></noframes><noembed><b>No embed</b></noembed> there</body></html>";
    expect(htmlToText(html)).toBe("Hi there");
  });

  it("shows noscript content, as mail clients run without scripts", () => {
    expect(htmlToText("Hi<noscript><p>Please enable images</p></noscript>there")).toBe("Hi\n\nPlease enable images\n\nthere");
  });

  it("keeps whitespace inside pre and collapses it elsewhere", () => {
    expect(htmlToText("<p>a   b\n c</p><pre>x  y\n  z</pre>")).toBe("a b c\n\nx  y\n  z");
  });

  it("converts nesting up to the browser limit in full", () => {
    expect(htmlToText("<div>".repeat(400) + "deep", Infinity)).toBe("deep");
  });

  // HTML past the parse limits is not rendered at all: the reader gets this note,
  // bestBodyText falls back to the text/plain part, and outgoing text is empty.
  const NOT_SHOWN = "[HTML not shown: this message's HTML is far outside what real email contains]";
  const expectNotShown = (html: string) => {
    const start = performance.now();
    expect(htmlToText(html, Infinity)).toBe(NOT_SHOWN);
    expect(bestBodyText({ text: "Plain part", html })).toBe("Plain part");
    expect(bestBodyText({ text: "", html })).toBe(NOT_SHOWN);
    expect(htmlToOutgoingText(html)).toBe("");
    // Generous: the limits stop these inputs within a fraction of this.
    expect(performance.now() - start).toBeLessThan(5000);
  };

  it("does not render HTML nested past the limit, templates included", () => {
    expectNotShown('<p>Hello <a href="https://evil.test/">more' + "<div>".repeat(100_000) + "deep");
    expectNotShown("Hi" + "<template>".repeat(5000));
  });

  it("does not render HTML with a tag carrying more attributes than the limit", () => {
    // Distinct names: the tokenizer compares each new attribute with every earlier one.
    const names = Array.from({ length: 50_000 }, (_, i) => `a${i}`).join(" ");
    expectNotShown(`<p>Bank</p><a ${names} href="https://evil.test/">Log in</a>`);
    expect(htmlToText(`<p ${Array.from({ length: 900 }, (_, i) => `a${i}`).join(" ")}>ok</p>`)).toBe("ok");
    // A quote in a comment, script or attribute value cannot hide the tag from the count.
    for (const lead of ['<!-- <a b=" -->', "<script>var s='<a b=\"';</script>"]) expectNotShown(`${lead}<p ${names}>hi</p>"`);
    expectNotShown(`<p title="<" ${names}>hi</p>`);
    expectNotShown(`<!-- <a b=" --><svg><style><p title="<x>" ${names}>hi</p></style></svg>"`);
    expectNotShown(`<p>hi</p ${names}>`);
  });

  it("charges the tokenizer's attribute comparisons to the work budget", () => {
    const names999 = Array.from({ length: 999 }, (_, i) => `a${i}`).join(" ");
    expectNotShown(`<p>hi</p>${`</i ${names999}>`.repeat(50)}`); // under the per-tag limit, on end tags
    expectNotShown(`<b ${names999}>x`.repeat(60)); // and on nested formatting elements
    expect(htmlToText(`<p>hi</p>${`</i ${names999}>`.repeat(5)}`)).toBe("hi");
  });

  it("does not render HTML whose tree construction would exceed the work budget", () => {
    // Each of these is quadratic (or deep-stack linear) in tree construction.
    expectNotShown("<table>" + "x<img>".repeat(200_000)); // foster parenting, text and elements
    expectNotShown("<table>" + "<img>".repeat(200_000)); // foster parenting, elements only
    expectNotShown("<i></i>".repeat(60_000) + "<table>" + "x<!---->".repeat(60_000)); // foster parenting, text only
    expectNotShown("<b><div>" + "x<br>".repeat(200_000) + "</b>end"); // adoption agency
    expectNotShown("<span>".repeat(508) + "<i></i>".repeat(40_000)); // siblings at depth 508
    expectNotShown("<span>".repeat(508) + "</x>".repeat(40_000)); // stray end tags scanning a deep stack
    expectNotShown("x".repeat(6_000_000)); // input far larger than real mail
  });

  it("renders repeated html and body tags without merging their attributes", () => {
    const html = Array.from({ length: 50_000 }, (_, i) => `<body a${i}>`).join("") + "<p>Hello</p>";
    const start = performance.now();
    expect(htmlToText(html, Infinity)).toBe("Hello");
    expect(htmlToText(Array.from({ length: 50_000 }, (_, i) => `<html a${i}>`).join("") + "Hello", Infinity)).toBe("Hello");
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it("breaks lines at block ends and separates table cells", () => {
    const html =
      "<h1>Order shipped</h1><p>Your order has shipped.</p>" +
      "<table><tr><td>Whole Milk 1 gal</td><td>1</td><td>$5.09</td></tr><tr><th>Total</th><td>$5.09</td></tr></table>" +
      "<ul><li>One</li><li>Two</li></ul><div>Thanks, <b>Example</b>Store</div>";
    expect(htmlToText(html)).toBe("Order shipped\n\nYour order has shipped.\n\nWhole Milk 1 gal 1 $5.09\nTotal $5.09\nOne\nTwo\nThanks, ExampleStore");
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

  it("keeps a link's URL after its text", () => {
    const html = '<p><a class="btn" href="https://example.com/signup?ref=news&amp;src=mail">Sign up</a> today</p>';
    expect(htmlToText(html)).toBe("Sign up <https://example.com/signup?ref=news&src=mail> today");
  });

  it("reads single-quoted and unquoted href values", () => {
    expect(htmlToText("<a href='https://example.com/a'>A</a> <a href=https://example.com/b>B</a>"))
      .toBe("A <https://example.com/a> B <https://example.com/b>");
  });

  it("shows the target even when the link text shows the same URL", () => {
    expect(htmlToText('<a href="https://example.com/">https://example.com/</a>'))
      .toBe("https://example.com/ <https://example.com/>");
    expect(htmlToText('<a href="https://www.example.com/">example.com</a>')).toBe("example.com <https://www.example.com/>");
    expect(htmlToText('<a href="https://example.com/x">Go to https://example.com/x now</a>'))
      .toBe("Go to https://example.com/x now <https://example.com/x>");
    expect(htmlToText('<a href="https://example.com/x">(https://example.com/x)</a>'))
      .toBe("(https://example.com/x) <https://example.com/x>");
    expect(htmlToText('<a href="https://EXAMPLE.com/a">example.com/a</a>')).toBe("example.com/a <https://example.com/a>");
  });

  it("keeps the URL of a link with no text", () => {
    expect(htmlToText('<a href="https://example.com/x"><img src="https://example.com/logo.png"></a>'))
      .toBe("<https://example.com/x>");
    expect(htmlToText('<p>Intro</p><a href="https://example.com/x"><img></a><div><a href="https://example.com/y"><img></a></div>'))
      .toBe("Intro\n\n<https://example.com/x>\n<https://example.com/y>");
    expect(htmlToText('Follow us<a href="https://a.example/"><img></a><a href="https://b.example/"><img></a>today'))
      .toBe("Follow us <https://a.example/> <https://b.example/> today");
  });

  it("shows fragment, script, and relative link targets as written", () => {
    expect(htmlToText('<a href="#top">Top</a> <a href="javascript:void(0)">Menu</a> <a href="/local">Here</a>'))
      .toBe("Top <#top> Menu <javascript:void(0)> Here </local>");
  });

  it("reads the href attribute, not a *-href attribute before it", () => {
    expect(htmlToText('<a data-href="https://track.example/x" href="https://example.com/y">Go</a>'))
      .toBe("Go <https://example.com/y>");
  });

  it("still shows the target when the link text shows a different URL that merely starts with it", () => {
    expect(htmlToText('<a href="https://example.co">https://example.com.other.test/login</a>'))
      .toBe("https://example.com.other.test/login <https://example.co/>");
    expect(htmlToText('<a href="https://example.com/">Unsubscribe at https://example.com/unsubscribe</a>'))
      .toBe("Unsubscribe at https://example.com/unsubscribe <https://example.com/>");
  });

  it("decodes an entity-encoded href once", () => {
    expect(htmlToText('<a href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;help@example.com&#63;subject=x">Email us</a>'))
      .toBe("Email us <help@example.com>");
    expect(htmlToText('<a href="https://example.com/?q=a&amp;lt;b">Q</a>')).toBe("Q <https://example.com/?q=a&lt;b>");
  });

  it("ends an unclosed anchor at the next one, carrying it into a following block as a browser does", () => {
    expect(htmlToText('<a href="https://a.example/">A<p>text <a href="https://b.example/">B</a>'))
      .toBe("A <https://a.example/>\n\ntext <https://a.example/> B <https://b.example/>");
  });

  it("keeps a link's target with its text and apart from what follows", () => {
    expect(htmlToText('Please review the <a href="https://x.test/x">deck </a>before Friday.'))
      .toBe("Please review the deck <https://x.test/x> before Friday.");
    expect(htmlToText('<a href="https://x.test/h">Home </a><a href="https://x.test/s">Shop </a>'))
      .toBe("Home <https://x.test/h> Shop <https://x.test/s>");
    expect(htmlToText('<p><a href="https://a.test/">Read the report<br></a>Unsubscribe here</p>'))
      .toBe("Read the report <https://a.test/>\nUnsubscribe here");
    expect(htmlToText('<a href="https://x.test/">Sign up</a>.')).toBe("Sign up <https://x.test/>.");
  });

  it("converts many unclosed anchors (each one runs the parser's adoption agency) quickly", () => {
    const html = '<a name="x">y '.repeat(50_000);
    const start = performance.now();
    htmlToText(html, Infinity);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("does not read href= text inside another attribute's value", () => {
    expect(htmlToText('<a title=" href=https://example.org" href="https://example.com/login">Account</a>'))
      .toBe("Account <https://example.com/login>");
  });

  it("allows > inside a quoted attribute value", () => {
    expect(htmlToText('<a title="a > b" href="https://example.com/x">Go</a>')).toBe("Go <https://example.com/x>");
  });

  it("shows the target when the link text differs from it only in case or scheme", () => {
    expect(htmlToText('<a href="https://example.com/Reset?t=AbC">https://example.com/reset?t=abc</a>'))
      .toBe("https://example.com/reset?t=abc <https://example.com/Reset?t=AbC>");
    expect(htmlToText('<a href="https://example.com/">ftp://example.com/</a>')).toBe("ftp://example.com/ <https://example.com/>");
  });

  it("drops line breaks inside a wrapped href", () => {
    expect(htmlToText('<a href="https://example.com/a\nb">Go</a>')).toBe("Go <https://example.com/ab>");
  });

  it("reads an unquoted href up to whitespace or the end of the tag", () => {
    expect(htmlToText("<a href=https://example.com/track?u=1&id=2>Read more</a>"))
      .toBe("Read more <https://example.com/track?u=1&id=2>");
    expect(htmlToText('<a href=https://example.com/a title="x">A</a>')).toBe("A <https://example.com/a>");
    // An unquoted value keeps a stray quote, so the next attribute is the real (first) href, as a browser reads it.
    expect(htmlToText('<a title=x" href=https://example.org href="https://example.com/b">B</a>'))
      .toBe("B <https://example.org/>");
    expect(htmlToText('<a title=x"y href="https://example.com/c">C</a>')).toBe("C <https://example.com/c>");
  });

  it("shows tel and sms targets as the bare number", () => {
    expect(htmlToText('<a href="tel:+1-555-0100">Call us</a>')).toBe("Call us <+1-555-0100>");
    expect(htmlToText('<a href="sms:+15550100?body=hi">Text us</a>')).toBe("Text us <+15550100>");
    expect(htmlToText('<a href="tel:+1-555-0100">+1 555 0100</a>')).toBe("+1 555 0100 <+1-555-0100>");
    expect(htmlToText('<a href="tel:+1%20555%200100">Call us</a>')).toBe("Call us <+1 555 0100>");
  });

  it("keeps protocol-relative targets as https and calendar subscriptions as written", () => {
    expect(htmlToText('<a href="//example.com/docs">Docs</a>')).toBe("Docs <https://example.com/docs>");
    expect(htmlToText('<a href="webcal://example.com/cal.ics">Subscribe</a>')).toBe("Subscribe <webcal://example.com/cal.ics>");
  });

  it("shows the real target when link text split by inline tags imitates it", () => {
    expect(htmlToText('<a href="https://evil.test/">https://accounts.example.com/<i>evil.test/</i></a>'))
      .toBe("https://accounts.example.com/evil.test/ <https://evil.test/>");
    expect(htmlToText('<a href="https://evil.test/">https://bank.example/<strong>evil.test</strong>/reset</a>'))
      .toBe("https://bank.example/evil.test/reset <https://evil.test/>");
    expect(htmlToText('<a href="mailto:attacker@evil.test">support@bank.example<span>attacker@evil.test</span></a>'))
      .toBe("support@bank.exampleattacker@evil.test <attacker@evil.test>");
  });

  it("reads markup as a browser parses it, so stray characters and comments cannot hide a target", () => {
    expect(htmlToText('<p>Prices <$10: <a href="https://shop.example/sale">see sale</a> today</p><p><b>Bye</b></p>'))
      .toBe("Prices <$10: see sale <https://shop.example/sale> today\n\nBye");
    expect(htmlToText('<a href="https://evil.test/"><!-- </a> -->https://bank.example/</a>'))
      .toBe("https://bank.example/ <https://evil.test/>");
    expect(htmlToText('<a title="Track > details" href="https://shop.example/t">Track</a>')).toBe("Track <https://shop.example/t>");
  });

  it("shows the outer target of nested, unclosed and oddly closed anchors", () => {
    expect(htmlToText('<a href="https://evil.test/">https://bank.example/<a href="https://bank.example/"></a></a>'))
      .toBe("https://bank.example/ <https://evil.test/> <https://bank.example/>");
    expect(htmlToText('<a href="https://evil.test/">https://bank.example/login</p>'))
      .toBe("https://bank.example/login <https://evil.test/>");
    expect(htmlToText('<a href="https://evil.test/">https://bank.example/</a x> more'))
      .toBe("https://bank.example/ <https://evil.test/> more");
  });

  it("resolves hrefs the way a browser does before checking the scheme", () => {
    for (const href of ["https:evil.test/", "https:\\\\evil.test\\", "https&colon;//evil.test/", "&#104ttps://evil.test/"]) {
      expect(htmlToText(`<a href="${href}">Bank</a>`)).toBe("Bank <https://evil.test/>");
    }
    expect(htmlToText('<a href="https://bank.example:pw@evil.test/x">Bank</a>')).toBe("Bank <https://evil.test/x>");
  });

  it("shows every mailto recipient, including to, cc and bcc fields", () => {
    expect(htmlToText('<a href="mailto:?to=attacker@evil.test">Email us</a>')).toBe("Email us <attacker@evil.test>");
    expect(htmlToText('<a href="mailto:help@example.com?bcc=attacker@evil.test&amp;subject=Hi">Email us</a>'))
      .toBe("Email us <help@example.com, bcc: attacker@evil.test>");
    expect(htmlToText('<a href="mailto:a+tag@example.com?cc=b%40example.com">Email us</a>'))
      .toBe("Email us <a+tag@example.com, cc: b@example.com>");
    expect(htmlToText('<a href="mailto:?subject=Hi">Email us</a>')).toBe("Email us");
  });

  it("reads tel, sms and mailto targets written with //", () => {
    expect(htmlToText('<a href="tel://+15551234">Call</a>')).toBe("Call <+15551234>");
    expect(htmlToText('<a href="tel://+1-555-1234/">Call</a>')).toBe("Call <+1-555-1234>");
    expect(htmlToText('<a href="sms://+15551234?body=hi">Text</a>')).toBe("Text <+15551234>");
    expect(htmlToText('<a href="mailto://help@example.com?cc=b@example.com">Mail</a>')).toBe("Mail <help@example.com, cc: b@example.com>");
    expect(htmlToText('<a href="mailto:help@example.com?">Mail</a> <a href="tel:+15551234#">Call</a>')).toBe("Mail <help@example.com> Call <+15551234>");
  });

  it("percent-encodes characters in a URL target that could forge another target", () => {
    expect(htmlToText('<a href="webcal:evil.test/x> <https://good.test/">Calendar</a>'))
      .toBe("Calendar <webcal:evil.test/x%3E%20%3Chttps://good.test/>");
  });

  it("shows image-map areas as links, with their alt text as the link text", () => {
    expect(htmlToText('<img usemap="#m"><map name="m"><area href="https://shop.test/" alt="Shop"><area href="https://help.test/" alt="Help"><area href="https://x.test/"></map>'))
      .toBe("Shop <https://shop.test/> Help <https://help.test/> <https://x.test/>");
  });

  it("follows an SVG link's href over its xlink:href, and xlink:href alone", () => {
    expect(htmlToText('<svg><a xlink:href="https://x.test/" href="https://y.test/"><text>Go</text></a></svg>')).toBe("Go <https://y.test/>");
    expect(htmlToText('<svg><a xlink:href="https://x.test/"><text>Go</text></a></svg>')).toBe("Go <https://x.test/>");
  });

  it("renders outgoing text without link targets or notes", () => {
    expect(htmlToOutgoingText('<p>See <a href="https://example.com/doc">the doc</a></p>')).toBe("See the doc");
    expect(htmlToOutgoingText("<p>Hi</p>" + "<div>".repeat(600) + "deep")).toBe("");
  });

  it("re-encodes characters in a decoded address or number that could reorder, hide or forge it", () => {
    expect(htmlToText('<a href="mailto:evil%E2%80%AEmoc.knab@x.test">Mail</a>')).toBe("Mail <evil%E2%80%AEmoc.knab@x.test>");
    expect(htmlToText('<a href="mailto:a%2C%20cc%3A%20boss@bank.example">Mail</a>')).toBe("Mail <a,%20cc:%20boss@bank.example>");
    expect(htmlToText('<a href="tel:+1%C2%85555%200100">Call</a>')).toBe("Call <+1%C2%85555 0100>");
  });

  it("shows a mailto target as the bare address", () => {
    expect(htmlToText('<a href="mailto:help@example.com?subject=Hi">Contact support</a>'))
      .toBe("Contact support <help@example.com>");
    expect(htmlToText('<a href="mailto:help@example.com">help@example.com</a>')).toBe("help@example.com <help@example.com>");
  });
});

describe("htmlToText targets that are relative or not web links", () => {
  const spoof = '<a href="login">https://chase.com/login</a>';

  it("shows a relative target as written when there is no <base>", () => {
    expect(htmlToText(spoof)).toBe("https://chase.com/login <login>");
    expect(htmlToText('<a href="../reset?u=1">Reset</a>')).toBe("Reset <../reset?u=1>");
    expect(htmlToText('<a href="chase.com/login">Sign in</a>')).toBe("Sign in <chase.com/login>");
  });

  it("resolves a relative target against the <base>, which is where a client that honors it goes", () => {
    expect(htmlToText(`<head><base href="https://evil.example/"></head><body>${spoof}</body>`))
      .toBe("https://chase.com/login <https://evil.example/login>");
    expect(htmlToText('<base href="https://evil.example/a/b"><a href="../x">X</a> <a href="/y">Y</a> <a href="?q=1">Q</a>'))
      .toBe("X <https://evil.example/x> Y <https://evil.example/y> Q <https://evil.example/a/b?q=1>");
  });

  it("applies a <base> that comes after the link, as a browser does", () => {
    expect(htmlToText(`${spoof}<base href="https://evil.example/">`))
      .toBe("https://chase.com/login <https://evil.example/login>");
  });

  it("uses only the first <base> with an href, and none at all if that one is not absolute", () => {
    expect(htmlToText(`<base target="_blank"><base href="https://evil.example/"><base href="https://chase.com/">${spoof}`))
      .toBe("https://chase.com/login <https://evil.example/login>");
    expect(htmlToText(`<base href="/relative/"><base href="https://evil.example/">${spoof}`))
      .toBe("https://chase.com/login <login>");
  });

  it("ignores an SVG <base> and one inside a <template>, which set no document base", () => {
    expect(htmlToText(`<svg><base href="https://evil.example/"></base></svg>${spoof}`)).toBe("https://chase.com/login <login>");
    expect(htmlToText(`<template><base href="https://evil.example/"></template>${spoof}`)).toBe("https://chase.com/login <login>");
  });

  it("resolves fragment-only, scheme-relative and empty hrefs against the <base>", () => {
    const base = '<base href="http://evil.example/p">';
    expect(htmlToText(`${base}<a href="#top">Top</a>`)).toBe("Top <http://evil.example/p#top>");
    expect(htmlToText(`${base}<a href="//cdn.example/x">CDN</a>`)).toBe("CDN <http://cdn.example/x>");
    expect(htmlToText(`${base}<a href="">Home</a> <a href="  ">Blank</a>`))
      .toBe("Home <http://evil.example/p> Blank <http://evil.example/p>");
  });

  it("shows both readings of a same-scheme href with no slashes: against the <base>, and without it", () => {
    const base = '<base href="https://evil.example/">';
    expect(htmlToText(`${base}<a href="https:chase.com/login">https://chase.com/login</a>`))
      .toBe("https://chase.com/login <https://evil.example/chase.com/login> or <https://chase.com/login>");
    expect(htmlToText(`${base}<a href="HTTPS:/chase.com/login">Sign in</a>`))
      .toBe("Sign in <https://evil.example/chase.com/login> or <https://chase.com/login>");
    expect(htmlToText('<base href="https://bank.example/"><a href="https:evil.test">Pay</a>'))
      .toBe("Pay <https://bank.example/evil.test> or <https://evil.test/>");
    expect(htmlToText('<base href="http://evil.example/"><a href="http:chase.com">Go</a><br><a href="http:chase.com"><img></a>'))
      .toBe("Go <http://evil.example/chase.com> or <http://chase.com/>\n<http://evil.example/chase.com> or <http://chase.com/>");
    expect(htmlToText(`${base}<a href="http:chase.com/x">Go</a>`)).toBe("Go <http://chase.com/x>");
  });

  it("shows nothing for an empty href when there is no <base>", () => {
    expect(htmlToText('<a href="">Home</a> <a href=" \t ">Blank</a>')).toBe("Home Blank");
  });

  it("shows a relative target as written when it cannot be resolved against the <base>", () => {
    expect(htmlToText(`<base href="mailto:help@example.com">${spoof}`)).toBe("https://chase.com/login <login>");
  });

  it("shows script and other non-web targets as written, and a data: URL's header only", () => {
    expect(htmlToText('<a href="javascript:location=\'https://evil.example/\'">https://chase.com/</a>'))
      .toBe("https://chase.com/ <javascript:location='https://evil.example/'>");
    expect(htmlToText('<a href="JavaScript:alert(1)">Go</a>')).toBe("Go <javascript:alert(1)>");
    expect(htmlToText('<a href="java\tscript:alert(1)">Go</a>')).toBe("Go <javascript:alert(1)>");
    expect(htmlToText('<a href="ms-word:ofe|u|https://evil.example/a.docx">Open</a>'))
      .toBe("Open <ms-word:ofe|u|https://evil.example/a.docx>");
    expect(htmlToText(`<a href="data:text/html;base64,${"A".repeat(5000)}">https://chase.com/</a>`))
      .toBe("https://chase.com/ <data:text/html;base64,\u2026>");
    expect(htmlToText(`<a href="DATA:text/plain,${"\u00e9".repeat(150)}">X</a>`)).toBe("X <data:text/plain,\u2026>");
    expect(htmlToText('<a href="data:,">X</a>')).toBe("X <data:,>");
  });

  it("shows a long non-web target in full, so a host late in it stays visible", () => {
    const handler = `ms-word:ofe|u|https://chase.com.${"a".repeat(300)}.evil.example/a.docx`;
    expect(htmlToText(`<a href="${handler}">Open statement</a>`)).toBe(`Open statement <${handler}>`);
  });

  it("drops a user:password part from a non-web target, which only disguises the host", () => {
    expect(htmlToText('<a href="ftp://chase.com@evil.example/f">Files</a>')).toBe("Files <ftp://evil.example/f>");
  });

  it("keeps a written-out target from breaking out of its brackets or hiding characters", () => {
    expect(htmlToText('<a href="a>b <c\u202Ed">X</a>')).toBe("X <a%3Eb%20%3Cc%E2%80%AEd>");
    expect(htmlToText('<a href="javascript:a>b">X</a>')).toBe("X <javascript:a%3Eb>");
  });

  it("leaves absolute web, mail and phone targets as they were, with or without a <base>", () => {
    const links = '<a href="https://chase.com/login">Sign in</a> <a href="mailto:help@chase.com">Mail</a> <a href="tel:+15550100">Call</a> <a href="//cdn.example/x">CDN</a>';
    const expected = "Sign in <https://chase.com/login> Mail <help@chase.com> Call <+15550100> CDN <https://cdn.example/x>";
    expect(htmlToText(links)).toBe(expected);
    expect(htmlToText(`<base href="https://evil.example/">${links}`))
      .toBe(expected);
  });

  it("does not add targets to outgoing text", () => {
    expect(htmlToOutgoingText(`<base href="https://evil.example/">${spoof} <a href="javascript:x">Go</a>`))
      .toBe("https://chase.com/login Go");
  });
});

describe("bestBodyText", () => {
  const newsletterHtml =
    "<p>This week we shipped a feature that syncs notes across every device, keeping both versions on conflict.</p>" +
    "<p>We also rewrote the search index, so queries over large libraries return in a fraction of the time.</p>" +
    '<p><a href="https://example.com/signup">Sign up</a> for the beta.</p>';

  it("prefers the HTML when the text/plain part is a short stub", () => {
    const body = bestBodyText({ text: "This email is best viewed in HTML. View it in your browser.", html: newsletterHtml });
    expect(body).toContain("rewrote the search index");
    expect(body).toContain("Sign up <https://example.com/signup>");
    expect(body).not.toContain("best viewed");
  });

  it("prefers the HTML when the stub's only content is a long view-online URL", () => {
    const text = `View online: https://example.com/view/${"a".repeat(300)}`;
    expect(bestBodyText({ text, html: newsletterHtml })).toContain("rewrote the search index");
  });

  it("still prefers a full text/plain alternative over the HTML", () => {
    const text =
      "This week we shipped a feature that syncs notes across every device, keeping both versions on conflict.\n\n" +
      "We also rewrote the search index, so queries over large libraries return in a fraction of the time.\n\n" +
      "Sign up for the beta: https://example.com/signup";
    expect(bestBodyText({ text, html: newsletterHtml })).toBe(text);
  });

  it("does not count attribute text as HTML prose", () => {
    const text = "Your order has shipped and should arrive on Thursday.";
    const html = `<p>${text}</p>` + '<a title="Track > details > status" href="https://shop.example/t">Track</a> '.repeat(6);
    expect(bestBodyText({ text, html })).toBe(text);
  });

  it("does not count the link targets htmlToText adds when comparing", () => {
    const text = "Call our support line any time; we answer within a minute.";
    const html = `<p>${text}</p>` + '<a href="tel:+1%20555%200100">x</a> '.repeat(20);
    expect(bestBodyText({ text, html })).toBe(text);
  });

  it("does not count link URLs when comparing, so long tracking links cannot outweigh the text/plain", () => {
    const text = "See the agenda: https://example.com/agenda";
    const html = `<p>See the <a href="https://example.com/r/${"t".repeat(400)}">agenda</a></p>`;
    expect(bestBodyText({ text, html })).toBe(text);
  });

  it("falls back to the HTML when the text/plain part is blank", () => {
    expect(bestBodyText({ text: "\r\n\u200c", html: '<p>Real <a href="https://example.com/r">body</a></p>' }))
      .toBe("Real body <https://example.com/r>");
  });

  it("measures unspaced (CJK) HTML prose past a link target", () => {
    const html = '<p><a href="https://example.com/a">こちら</a>' + "から今週の新機能をご紹介します。".repeat(20) + "</p>";
    expect(bestBodyText({ text: "HTMLメールを表示できない場合はブラウザでご覧ください", html })).toContain("今週の新機能");
  });

  it("does not count preheader entity padding as HTML prose", () => {
    const text = "Thanks for your order #1234. It ships tomorrow.";
    const html = "<p>Your receipt" + "&zwnj;&nbsp;&shy;".repeat(100) + "</p><p>Thanks for your order #1234. It ships tomorrow.</p>";
    expect(bestBodyText({ text, html })).toBe(text);
  });

  it("keeps a text/plain part when the HTML has no text of its own", () => {
    expect(bestBodyText({ text: "Photo attached", html: '<img src="https://example.com/p.jpg">' })).toBe("Photo attached");
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

  it("falls back to HTML when the text/plain part is whitespace only", () => {
    // An HTML-only sender still emits a text/plain part, typically a bare newline.
    // It is truthy, so an untrimmed check returns it and drops the whole body.
    const msg = {
      id: "m3",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("\r\n").toString("base64url") } },
          { mimeType: "text/html", body: { data: Buffer.from("<p>Real body</p>").toString("base64url") } },
        ],
      },
    };
    expect(formatMessage(msg).body).toBe("Real body");
  });

  it("still prefers a genuine text/plain part over the HTML alternative", () => {
    const msg = {
      id: "m4",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("Plain wins").toString("base64url") } },
          { mimeType: "text/html", body: { data: Buffer.from("<p>Nope</p>").toString("base64url") } },
        ],
      },
    };
    expect(formatMessage(msg).body).toBe("Plain wins");
  });

  it("falls back to HTML when the text/plain part is only zero-width padding", () => {
    // String#trim() does not strip U+200C and friends, so a padded stub survives it.
    const msg = {
      id: "m5",
      payload: {
        mimeType: "multipart/alternative",
        headers: [],
        parts: [
          { mimeType: "text/plain", body: { data: Buffer.from("\u200c \u200c \u200c").toString("base64url") } },
          { mimeType: "text/html", body: { data: Buffer.from("<p>Real body</p>").toString("base64url") } },
        ],
      },
    };
    expect(formatMessage(msg).body).toBe("Real body");
  });

  it("returns an empty body when the text part is blank and there is no HTML", () => {
    const msg = {
      id: "m6",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { data: Buffer.from("  \n ").toString("base64url") },
      },
    };
    expect(formatMessage(msg).body).toBe("");
  });

  it("caps the trimmed text, so leading whitespace cannot push content past the cap", () => {
    // The emptiness check and the capped value must agree on what the body is.
    const msg = {
      id: "m7",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { data: Buffer.from(" ".repeat(49_990) + "CONTENT THAT MUST SURVIVE").toString("base64url") },
      },
    };
    expect(formatMessage(msg).body).toContain("CONTENT THAT MUST SURVIVE");
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

describe("formatMessage rfc822MessageId", () => {
  const withHeaders = (headers: { name: string; value: string }[]) => ({
    id: "m1",
    payload: {
      mimeType: "text/plain",
      headers,
      body: { data: Buffer.from("body").toString("base64url") },
    },
  });

  it("returns the RFC822 Message-ID header verbatim, angle brackets included", () => {
    const msg = withHeaders([
      { name: "Subject", value: "hi" },
      { name: "Message-ID", value: "<CAB=abc123@mail.gmail.com>" },
    ]);
    expect(formatMessage(msg).rfc822MessageId).toBe("<CAB=abc123@mail.gmail.com>");
  });

  it("matches the header case-insensitively", () => {
    const msg = withHeaders([{ name: "message-id", value: "<lower@example.com>" }]);
    expect(formatMessage(msg).rfc822MessageId).toBe("<lower@example.com>");
  });

  it("omits the key entirely when the header is absent", () => {
    const formatted = formatMessage(withHeaders([{ name: "Subject", value: "no msgid" }]));
    expect("rfc822MessageId" in formatted).toBe(false);
  });

  it("omits the key when the header is present but empty", () => {
    const formatted = formatMessage(withHeaders([{ name: "Message-ID", value: "" }]));
    expect("rfc822MessageId" in formatted).toBe(false);
  });

  // Relayed and forwarded mail can carry more than one Message-ID. getHeader takes the first;
  // this pins that first-wins behavior so a change to it is deliberate, not accidental.
  it("takes the first Message-ID when a relayed message carries several", () => {
    const msg = withHeaders([
      { name: "Message-ID", value: "<original@sender.example>" },
      { name: "Message-ID", value: "<rewritten@relay.example>" },
    ]);
    expect(formatMessage(msg).rfc822MessageId).toBe("<original@sender.example>");
  });
});
