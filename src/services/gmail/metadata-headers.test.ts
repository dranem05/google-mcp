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
