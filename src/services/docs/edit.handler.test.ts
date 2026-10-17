import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the googleapis Docs/Drive clients so the real docs_* handlers run
// against a recorded batchUpdate — no network, no credentials.
const docsStub = { documents: { batchUpdate: vi.fn(), get: vi.fn() } };
vi.mock("googleapis", () => ({ google: { docs: () => docsStub, drive: () => ({}) } }));

const { registerDocsTools } = await import("./index.js");

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

const handlers = new Map<string, Handler>();
const server = { tool: (toolName: string, ...rest: unknown[]) => handlers.set(toolName, rest[rest.length - 1] as Handler) };
registerDocsTools(server as never, { auth: {} } as never);

function handler(name: string): Handler {
  const h = handlers.get(name);
  if (!h) throw new Error(`tool ${name} not registered`);
  return h;
}

function sentRequests(): unknown[] {
  expect(docsStub.documents.batchUpdate).toHaveBeenCalledTimes(1);
  return docsStub.documents.batchUpdate.mock.calls[0][0].requestBody.requests;
}

const range = { documentId: "doc1", startIndex: 7, endIndex: 13 };

beforeEach(() => {
  vi.clearAllMocks();
  docsStub.documents.batchUpdate.mockResolvedValue({ data: {} });
});

describe("docs_delete_text", () => {
  it("sends a single deleteContentRange for the range", async () => {
    await handler("docs_delete_text")(range);
    expect(docsStub.documents.batchUpdate.mock.calls[0][0].documentId).toBe("doc1");
    expect(sentRequests()).toEqual([{ deleteContentRange: { range: { startIndex: 7, endIndex: 13 } } }]);
  });
});

describe("docs_apply_text_style link handling", () => {
  const apply = handler("docs_apply_text_style");

  it("removeLink puts link in the field mask with no link value, so Docs clears it", async () => {
    await apply({ ...range, removeLink: true });
    expect(sentRequests()).toEqual([
      { updateTextStyle: { textStyle: {}, range: { startIndex: 7, endIndex: 13 }, fields: "link" } },
    ]);
  });

  it("removeLink combines with other style fields", async () => {
    await apply({ ...range, removeLink: true, bold: true });
    expect(sentRequests()).toEqual([
      { updateTextStyle: { textStyle: { bold: true }, range: { startIndex: 7, endIndex: 13 }, fields: "bold,link" } },
    ]);
  });

  it("removeLink: false leaves links alone", async () => {
    await apply({ ...range, removeLink: false, bold: true });
    expect(sentRequests()).toEqual([
      { updateTextStyle: { textStyle: { bold: true }, range: { startIndex: 7, endIndex: 13 }, fields: "bold" } },
    ]);
  });

  it("link still sets a link", async () => {
    await apply({ ...range, link: "https://example.com/" });
    expect(sentRequests()).toEqual([
      { updateTextStyle: { textStyle: { link: { url: "https://example.com/" } }, range: { startIndex: 7, endIndex: 13 }, fields: "link" } },
    ]);
  });

  it.each(["", "   "])("rejects an empty link (%j) and names removeLink, without calling Docs", async (link) => {
    await expect(apply({ ...range, link })).rejects.toThrow(/removeLink/);
    expect(docsStub.documents.batchUpdate).not.toHaveBeenCalled();
  });

  it("rejects an empty link even alongside another style, rather than silently keeping the link", async () => {
    await expect(apply({ ...range, link: "", bold: true })).rejects.toThrow(/removeLink/);
    expect(docsStub.documents.batchUpdate).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/", ""])("rejects removeLink together with link (%j)", async (link) => {
    await expect(apply({ ...range, removeLink: true, link })).rejects.toThrow(/not both/);
    expect(docsStub.documents.batchUpdate).not.toHaveBeenCalled();
  });
});

describe("docs_modify_text", () => {
  const modify = handler("docs_modify_text");

  it("rejects an empty newText and names docs_delete_text, without calling Docs", async () => {
    await expect(modify({ ...range, newText: "" })).rejects.toThrow(/docs_delete_text/);
    expect(docsStub.documents.batchUpdate).not.toHaveBeenCalled();
  });

  it("still replaces a range with non-empty text", async () => {
    await modify({ ...range, newText: "new" });
    expect(sentRequests()).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 13 } } },
      { insertText: { text: "new", location: { index: 7 } } },
    ]);
  });
});
