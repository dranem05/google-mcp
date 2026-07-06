import { describe, expect, it } from "vitest";
import { concatMarkdownForAppend } from "./markdown.js";

describe("concatMarkdownForAppend", () => {
  it("returns the new markdown untouched when the document is empty", () => {
    expect(concatMarkdownForAppend("", "# New")).toBe("# New");
  });

  it("returns the new markdown when the existing export is only whitespace", () => {
    expect(concatMarkdownForAppend("\n\n  \n", "# New")).toBe("# New");
  });

  it("separates existing and appended content with exactly one blank line", () => {
    expect(concatMarkdownForAppend("# Title\n\nBody text.\n", "## Section\n\nMore.")).toBe(
      "# Title\n\nBody text.\n\n## Section\n\nMore."
    );
  });

  it("collapses trailing newlines on the existing content before the separator", () => {
    // Multiple trailing newlines from the export must not produce a widening gap.
    expect(concatMarkdownForAppend("A\n\n\n\n", "B")).toBe("A\n\nB");
  });

  it("strips leading newlines on the addition so the separator is deterministic", () => {
    expect(concatMarkdownForAppend("A", "\n\n\nB")).toBe("A\n\nB");
  });
});
