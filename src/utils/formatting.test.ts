import { describe, expect, it } from "vitest";
import { textResult, mimeShortcut } from "./formatting.js";

describe("textResult", () => {
  it("passes strings through verbatim", () => {
    expect(textResult("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("JSON-encodes objects without pretty-print indentation", () => {
    const result = textResult({ a: 1, b: [1, 2, 3] });
    const text = result.content[0].text;
    expect(text).toBe('{"a":1,"b":[1,2,3]}');
    // No newlines/indentation spent on whitespace.
    expect(text).not.toContain("\n");
    expect(text).not.toMatch(/ {2,}/);
  });

  it("round-trips through JSON.parse", () => {
    const data = { nested: { arr: [1, "two", null] } };
    const result = textResult(data);
    expect(JSON.parse(result.content[0].text)).toEqual(data);
  });

  it("encodes arrays compactly", () => {
    const result = textResult([{ id: 1 }, { id: 2 }]);
    expect(result.content[0].text).toBe('[{"id":1},{"id":2}]');
  });
});

describe("mimeShortcut", () => {
  it("expands known shortcuts", () => {
    expect(mimeShortcut("document")).toBe("application/vnd.google-apps.document");
    expect(mimeShortcut("folder")).toBe("application/vnd.google-apps.folder");
  });

  it("passes through unknown values unchanged", () => {
    expect(mimeShortcut("application/pdf")).toBe("application/pdf");
    expect(mimeShortcut("custom/mime")).toBe("custom/mime");
  });
});
