import { describe, expect, it } from "vitest";
import { SEARCH_METADATA_HEADERS, THREAD_METADATA_HEADERS, projectSearchHit, pruneThreadMessage } from "./index.js";

// Gmail's "metadata" format returns only the headers named in metadataHeaders. Dropping an
// entry does not error — the field just comes back absent, so a caller sees "this message has
// no Message-ID" instead of "we forgot to ask for it". These pin the entries callers depend on.
describe("metadata header lists", () => {
  it("requests Message-ID on the search path, so hits carry rfc822MessageId", () => {
    expect(SEARCH_METADATA_HEADERS).toContain("Message-ID");
  });

  it("requests Message-ID on the thread path, so metadata-mode messages carry rfc822MessageId", () => {
    expect(THREAD_METADATA_HEADERS).toContain("Message-ID");
  });

  it("still requests the headers each formatter projects", () => {
    expect(SEARCH_METADATA_HEADERS).toEqual(expect.arrayContaining(["From", "To", "Subject", "Date"]));
    expect(THREAD_METADATA_HEADERS).toEqual(expect.arrayContaining(["From", "To", "Cc", "Date", "Subject"]));
  });
});

describe("rfc822MessageId projections", () => {
  const msg = (headers: { name: string; value: string }[]) => ({
    id: "m1",
    threadId: "t1",
    snippet: "s",
    payload: { mimeType: "text/plain", headers, body: { data: Buffer.from("body").toString("base64url") } },
  });
  const withId = msg([{ name: "Subject", value: "hi" }, { name: "Message-ID", value: "<a@b.example>" }]);
  const noId = msg([{ name: "Subject", value: "hi" }]);

  it("search hit carries rfc822MessageId when the header exists", () => {
    expect(projectSearchHit(withId).rfc822MessageId).toBe("<a@b.example>");
  });
  it("search hit omits the key when the header is absent", () => {
    expect("rfc822MessageId" in projectSearchHit(noId)).toBe(false);
  });
  it("thread message carries rfc822MessageId when the header exists", () => {
    expect(pruneThreadMessage(withId).rfc822MessageId).toBe("<a@b.example>");
  });
  it("thread message omits the key when the header is absent", () => {
    expect("rfc822MessageId" in pruneThreadMessage(noId)).toBe(false);
  });
});

describe("projection shapes", () => {
  const b64 = (t: string) => Buffer.from(t).toString("base64url");
  const headers = [
    { name: "Subject", value: "hi" },
    { name: "From", value: "a@example.com" },
    { name: "To", value: "b@example.com" },
    { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
    { name: "Message-ID", value: "<a@b.example>" },
  ];
  it("search hit projects exactly the expected fields", () => {
    const hit = projectSearchHit({ id: "m1", threadId: "t1", snippet: "s", payload: { headers } });
    expect(hit).toEqual({
      id: "m1", threadId: "t1", snippet: "s", subject: "hi", from: "a@example.com",
      date: "Mon, 1 Jan 2024 00:00:00 +0000", rfc822MessageId: "<a@b.example>",
    });
  });
  it("thread message falls back to HTML when text/plain is only zero-width padding", () => {
    const out = pruneThreadMessage({
      id: "m1",
      payload: {
        mimeType: "multipart/alternative",
        headers,
        parts: [
          { mimeType: "text/plain", body: { data: b64("\u200c \u200c \u200c") } },
          { mimeType: "text/html", body: { data: b64("<p>Real content</p>") } },
        ],
      },
    });
    expect(out.body).toContain("Real content");
  });
  it("thread message truncates long bodies", () => {
    const out = pruneThreadMessage({
      id: "m1",
      payload: { mimeType: "text/plain", headers, body: { data: b64("x".repeat(2500)) } },
    });
    expect(out.body).toBe(`${"x".repeat(2000)}\n\n[truncated]`);
  });
});
