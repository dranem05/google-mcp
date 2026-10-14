import { describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocsTools } from "./index.js";

const driveApiMock = {
  comments: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  replies: {
    create: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("googleapis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("googleapis")>();
  return {
    ...actual,
    google: {
      ...actual.google,
      docs: vi.fn(() => ({})),
      drive: vi.fn(() => driveApiMock),
    },
  };
});

/** Gets a registered tool's handler directly from the McpServer's internal registry. */
function toolCallback(server: McpServer, name: string): (args: unknown) => unknown {
  return (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => unknown }> })
    ._registeredTools[name].handler;
}

describe("docs_edit_reply", () => {
  function makeServer() {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDocsTools(server, { auth: new OAuth2Client(), accountSlug: "test-slug" });
    return server;
  }

  it("calls replies.update with the exact request shape", async () => {
    driveApiMock.replies.update.mockResolvedValueOnce({
      data: { id: "reply1", content: "updated text", modifiedTime: "2026-01-01T00:00:00Z" },
    });
    const server = makeServer();
    const result = await toolCallback(server, "docs_edit_reply")({
      documentId: "doc1",
      commentId: "comment1",
      replyId: "reply1",
      content: "updated text",
    });

    expect(driveApiMock.replies.update).toHaveBeenCalledWith({
      fileId: "doc1",
      commentId: "comment1",
      replyId: "reply1",
      fields: "id,content,author,modifiedTime",
      requestBody: { content: "updated text" },
    });
    expect(JSON.parse((result as { content: [{ text: string }] }).content[0].text)).toEqual({
      id: "reply1",
      content: "updated text",
      modifiedTime: "2026-01-01T00:00:00Z",
    });
  });
});
