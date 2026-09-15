import { describe, expect, it } from "vitest";
import { SEARCH_METADATA_HEADERS, THREAD_METADATA_HEADERS } from "./index.js";

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
