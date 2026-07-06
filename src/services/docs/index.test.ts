import { describe, expect, it } from "vitest";
import { docs_v1 } from "googleapis";
import { findInsertedTable, summarizeDocumentStructure } from "./index.js";

/**
 * Per the Docs API (Schema$InsertTableRequest.location): "A newline
 * character will be inserted before the inserted table, therefore the
 * table start index will be at the specified location index + 1."
 */
describe("findInsertedTable", () => {
  const tableAt = (startIndex: number, marker: number): docs_v1.Schema$StructuralElement => ({
    startIndex,
    endIndex: startIndex + 10,
    table: { rows: marker, columns: 1, tableRows: [] },
  });

  const paragraphAt = (startIndex: number): docs_v1.Schema$StructuralElement => ({
    startIndex,
    endIndex: startIndex + 1,
    paragraph: { elements: [] },
  });

  it("selects the table at insertionIndex + 1, not a decoy table elsewhere", () => {
    const content: docs_v1.Schema$StructuralElement[] = [
      paragraphAt(1),
      tableAt(5, 111), // decoy: pre-existing table earlier in the doc
      paragraphAt(15),
      tableAt(21, 222), // the just-inserted table (insertion at index 20 -> startIndex 21)
      paragraphAt(31),
    ];
    const found = findInsertedTable(content, 20);
    expect(found?.rows).toBe(222);
  });

  it("does not match a table sitting exactly at the insertion index", () => {
    // A table at startIndex === insertionIndex is NOT the inserted table
    // (that position is impossible for the new table; insertion shifts it +1).
    const content = [tableAt(20, 111)];
    expect(findInsertedTable(content, 20)).toBeUndefined();
  });

  it("returns undefined when no table matches (so callers must error, not report success)", () => {
    const content = [paragraphAt(1), tableAt(5, 111)];
    expect(findInsertedTable(content, 40)).toBeUndefined();
  });

  it("returns undefined for missing content", () => {
    expect(findInsertedTable(undefined, 10)).toBeUndefined();
  });
});

describe("summarizeDocumentStructure", () => {
  const paragraphWithImage: docs_v1.Schema$StructuralElement = {
    startIndex: 1,
    endIndex: 2,
    paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: "img1" } }] },
  };
  const plainParagraph: docs_v1.Schema$StructuralElement = {
    startIndex: 2,
    endIndex: 10,
    paragraph: { elements: [{ textRun: { content: "hello" } }] },
  };
  const tableElement: docs_v1.Schema$StructuralElement = {
    startIndex: 10,
    endIndex: 20,
    table: { rows: 2, columns: 2, tableRows: [] },
  };

  it("summarizes a single-tab (no-tabs) document by counting body elements", () => {
    const doc: docs_v1.Schema$Document = {
      documentId: "doc1",
      title: "My Doc",
      revisionId: "rev1",
      body: { content: [paragraphWithImage, plainParagraph, tableElement] },
    };
    const summary = summarizeDocumentStructure(doc);
    expect(summary.documentId).toBe("doc1");
    expect(summary.title).toBe("My Doc");
    expect(summary.revisionId).toBe("rev1");
    expect(summary.tabCount).toBe(1);
    expect(summary.tabs).toEqual([
      { tabId: undefined, title: "My Doc", paragraphs: 2, tables: 1, images: 1 },
    ]);
  });

  it("handles a document with no body content at all", () => {
    const doc: docs_v1.Schema$Document = { documentId: "empty", title: "Empty" };
    const summary = summarizeDocumentStructure(doc);
    expect(summary.tabCount).toBe(1);
    expect(summary.tabs[0]).toEqual({ tabId: undefined, title: "Empty", paragraphs: 0, tables: 0, images: 0 });
  });

  it("summarizes each tab separately, including nested child tabs", () => {
    const doc: docs_v1.Schema$Document = {
      documentId: "doc2",
      title: "Tabbed Doc",
      tabs: [
        {
          tabProperties: { tabId: "t1", title: "Tab One" },
          documentTab: { body: { content: [plainParagraph] } },
          childTabs: [
            {
              tabProperties: { tabId: "t1a", title: "Tab One Child" },
              documentTab: { body: { content: [tableElement] } },
            },
          ],
        },
        {
          tabProperties: { tabId: "t2", title: "Tab Two" },
          documentTab: { body: { content: [paragraphWithImage, tableElement] } },
        },
      ],
    };
    const summary = summarizeDocumentStructure(doc);
    expect(summary.tabCount).toBe(3);
    expect(summary.tabs).toEqual([
      { tabId: "t1", title: "Tab One", paragraphs: 1, tables: 0, images: 0 },
      { tabId: "t1a", title: "Tab One Child", paragraphs: 0, tables: 1, images: 0 },
      { tabId: "t2", title: "Tab Two", paragraphs: 1, tables: 1, images: 1 },
    ]);
  });
});
