import { describe, expect, it } from "vitest";
import { drive_v3 } from "googleapis";
import { formatFileForList } from "./index.js";

describe("formatFileForList", () => {
  const file: drive_v3.Schema$File = {
    id: "file1",
    name: "Report.docx",
    mimeType: "application/vnd.google-apps.document",
    size: "12345",
    modifiedTime: "2026-07-01T00:00:00Z",
    createdTime: "2026-01-01T00:00:00Z",
    parents: ["folder1"],
    owners: [{ displayName: "Alice" }],
    webViewLink: "https://docs.google.com/document/d/file1/edit",
  };

  it("prunes to id/name/mimeType/modifiedTime/size/parents", () => {
    expect(formatFileForList(file)).toEqual({
      id: "file1",
      name: "Report.docx",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-07-01T00:00:00Z",
      size: "12345",
      parents: ["folder1"],
    });
  });

  it("drops owner, webViewLink, and createdTime", () => {
    const result = formatFileForList(file) as Record<string, unknown>;
    expect("owner" in result).toBe(false);
    expect("owners" in result).toBe(false);
    expect("url" in result).toBe(false);
    expect("webViewLink" in result).toBe(false);
    expect("createdTime" in result).toBe(false);
  });

  it("handles a file with no parents (e.g. a Shared Drive root item)", () => {
    const { parents: _parents, ...noParents } = file;
    expect(formatFileForList(noParents).parents).toBeUndefined();
  });
});
